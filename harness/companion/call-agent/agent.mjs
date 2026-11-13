// The LiveKit worker for companion calls. LiveKit hears the caller, decides when a turn ends and
// plays the companion's voice; the companion's own session decides every word through its call
// bridge. Nothing here composes speech, so the call cannot sound like anyone but the companion.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { AgentSessionEventTypes, ServerOptions, cli, defineAgent, inference, llm, log, voice } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as fishaudio from '@livekit/agents-plugin-fishaudio';
import * as openai from '@livekit/agents-plugin-openai';
import { createBridge } from './bridge.mjs';
import { readElevenLabsKey, readOpenAiKey, resolveCompanion, voiceChoices } from './companion.mjs';
import { AGENT_NAME } from './livekit.mjs';

/** Tells the call service (control.mjs) what was said and when the call ended; best effort. */
function reporter(callId) {
  const base = process.env.RUBATO_CALL_CONTROL;
  return (type, text) => {
    if (!base || !callId) return Promise.resolve();
    return fetch(`${base}/event`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, type, text }) }).then(() => {}, () => {});
  };
}

/** Sentences of a bridge reply as a text stream; `onSentence` hears each one as it goes out. */
function sentences(events, { onSentence = () => {}, onFirst = () => {}, onEnd = () => {}, onCancel = () => {}, signal } = {}) {
  return new ReadableStream({
    async pull(stream) {
      try {
        for (;;) {
          const { value, done } = await events.next();
          if (done) { stream.close(); return; }
          if (value.t === 'delta' && value.text.trim()) {
            onFirst(); onSentence(value.text); stream.enqueue(value.text); return;
          }
          if (value.t === 'timing') continue;
          if (value.t === 'done' || value.t === 'error') { onEnd(value); stream.close(); return; }
        }
      } catch (error) {
        if (!signal?.aborted) log().error({ error: String(error) }, 'call bridge reply failed');
        stream.close();
      }
    },
    cancel: () => onCancel(),
  });
}
const LATENCY_LOG = path.join(process.env.RUBATO_CALL_HOME ?? path.join(os.homedir(), '.rubato', 'call'), 'latency.jsonl');

function lastUserText(chatCtx) {
  for (let at = chatCtx.items.length - 1; at >= 0; at--) {
    const item = chatCtx.items[at];
    if (item.type === 'message' && item.role === 'user') return item.textContent?.trim() ?? '';
  }
  return '';
}

function record(entry) {
  try {
    mkdirSync(path.dirname(LATENCY_LOG), { recursive: true, mode: 0o700 });
    appendFileSync(LATENCY_LOG, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {}
}

/**
 * The session skips replying when it has no LLM, so the companion holds that slot. It is never
 * asked to chat: CompanionVoice.llmNode replaces the step that would call it.
 */
class CompanionSlot extends llm.LLM {
  label() { return 'rubato.companion'; }
  get model() { return 'companion-session'; }
  chat() { throw new Error('a companion answers through its call bridge, not chat()'); }
}

/** The engine this call speaks with: the one the caller picked, else the voice-reply setting. */
export function voiceEngine(companion, picked) {
  const choices = voiceChoices(companion);
  const choice = choices.find(item => item.id === picked) ?? choices[0];
  if (!choice.ready) throw new Error(choice.reason);
  if (choice.provider === 'elevenlabs')
    return { choice, tts: new elevenlabs.TTS({ apiKey: readElevenLabsKey(), model: choice.model, voiceId: choice.voiceId, language: 'ko' }) };
  return { choice, tts: new fishaudio.TTS({ apiKey: companion.fishKey, model: choice.model, voiceId: choice.voiceId,
    temperature: companion.voice.temperature, latencyMode: 'balanced' }) };
}

class CompanionVoice extends voice.Agent {
  constructor({ companion, bridge, callId, timings, report }) {
    super({ instructions: '' });
    this.companion = companion; this.bridge = bridge; this.callId = callId; this.timings = timings; this.report = report;
  }

  async llmNode(chatCtx) {
    const heard = lastUserText(chatCtx);
    const logger = log();
    logger.info({ heard }, 'turn to companion');
    if (!heard) return null;
    if (process.env.RUBATO_CALL_ECHO === "1") return new ReadableStream({ start(s) { s.enqueue(`${heard}라고 했지?`); s.close(); } });
    const turnId = randomUUID();
    const controller = new AbortController();
    const timing = { callId: this.callId, companion: this.companion.id, turnId, heard, turnAt: Date.now() };
    this.timings.current = timing;
    const events = this.bridge.turn(heard, { turnId, signal: controller.signal });
    const stream = sentences(events, { signal: controller.signal,
      onFirst: () => { timing.firstSentenceAt ??= Date.now(); },
      onSentence: text => void this.report('said', text),
      onEnd: value => { timing.endedAt = Date.now(); timing.result = value.t === 'done' ? value.source : value.message; },
      onCancel: () => { timing.cancelled = true; controller.abort(); } });
    return stream;
  }

  async ttsNode(text, modelSettings) {
    const speakable = this.companion.speakable;
    const spoken = new ReadableStream({
      async start(stream) {
        for await (const part of text) stream.enqueue(speakable(part));
        stream.close();
      },
    });
    return voice.Agent.default.ttsNode(this, spoken, modelSettings);
  }
}

/**
 * Opens the call with the companion's own first words. The bridge refuses while the companion is
 * still busy (finishing the turn that placed the call, or anything else), so this asks again until
 * it is free, unless the person spoke first.
 */
async function speakFirst({ session, bridge, report, why, logger, stillFirst = () => true, tries = 40 }) {
  if (process.env.RUBATO_CALL_ECHO === '1') { session.say('여보세요?'); return; }
  for (let attempt = 0; attempt < tries; attempt++) {
    // Once the person has spoken, a late hello would answer nothing.
    if (!stillFirst()) return;
    const answer = await bridge.opportunity(why).catch(error => ({ error }));
    if (answer.events) {
      session.say(sentences(answer.events, { onSentence: text => void report('said', text) }));
      return;
    }
    if (answer.status !== 409) { logger.warn({ error: String(answer.error ?? answer.status) }, 'could not open the call'); return; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// Fish's socket can deliver a last frame after a call ended and its queue closed; the plugin throws
// that from a socket callback, which would end the worker and every call on it. Only that one is let go.
process.on('uncaughtException', error => {
  if (error?.message === 'Queue is closed') { log().warn({ error: error.message }, 'late voice frame after the call ended'); return; }
  throw error;
});

export default defineAgent({
  entry: async ctx => {
    const logger = log();
    const job = JSON.parse(ctx.job.metadata || '{}');
    const { companion: id, voice: picked } = job;
    const companion = resolveCompanion(id);
    const engine = voiceEngine(companion, picked);
    const openAiKey = readOpenAiKey();
    if (!openAiKey) throw new Error('no OpenAI key for transcription (~/.rubato/voice.json)');
    const bridge = createBridge(companion.bridge);
    const callId = job.callId ?? ctx.room.name ?? randomUUID();
    const report = reporter(job.callId);
    // Echo mode tests the audio path without reaching the companion's conversation at all.
    const opened = process.env.RUBATO_CALL_ECHO === '1' ? { health: {}, end: async () => {} }
      : await bridge.open(callId, { onEvent: event => logger.debug({ event }, 'bridge') });
    ctx.addShutdownCallback(async () => { await opened.end(); await report('ended'); });
    const timings = { current: null };
    logger.info({ voice: engine.choice.id }, 'call voice');

    const session = new voice.AgentSession({
      vad: new inference.VAD(),
      llm: new CompanionSlot(),
      // The markdown and emoji filters hold each sentence back until the next one arrives. call_say
      // already forbids markdown, so sentences go straight to the voice.
      ttsTextTransforms: null,
      stt: new openai.STT({ apiKey: openAiKey, model: 'gpt-live-transcribe', useRealtime: true, language: 'ko',
        keywords: [companion.title, companion.userLabel].filter(Boolean) }),
      tts: engine.tts,
      turnHandling: {
        turnDetection: new inference.TurnDetector({ version: 'v1-mini' }),
        // The transcript lands about half a second after speech stops; ending a turn sooner commits
        // it without the last sentence.
        endpointing: { mode: 'dynamic', minDelay: 800, maxDelay: 3000 },
        interruption: { mode: 'vad', resumeFalseInterruption: true, falseInterruptionTimeout: 1000 },
        // A speculative turn would reach the companion's real conversation. Turns go out only once.
        preemptiveGeneration: { enabled: false },
      },
    });

    session.on(AgentSessionEventTypes.UserStateChanged, ev => {
      logger.debug({ from: ev.oldState, to: ev.newState }, 'user state');
      if (ev.newState === 'listening' && ev.oldState === 'speaking') timings.speechEndedAt = Date.now();
    });
    session.on(AgentSessionEventTypes.AgentStateChanged, ev => {
      logger.debug({ from: ev.oldState, to: ev.newState }, 'agent state');
      const timing = timings.current;
      if (!timing || ev.newState !== 'speaking' || timing.speakingAt) return;
      timing.speakingAt = Date.now();
      timing.speechEndedAt = timings.speechEndedAt;
      const span = (from, to) => from && to ? to - from : null;
      const summary = {
        endToVoiceMs: span(timing.speechEndedAt, timing.speakingAt),
        endToTurnMs: span(timing.speechEndedAt, timing.turnAt),
        turnToSentenceMs: span(timing.turnAt, timing.firstSentenceAt),
        sentenceToVoiceMs: span(timing.firstSentenceAt, timing.speakingAt),
      };
      logger.info(summary, 'call latency');
      record({ ...timing, voice: engine.choice.id, ...summary });
    });
    session.on(AgentSessionEventTypes.UserInputTranscribed, ev => {
      if (!ev.isFinal) return;
      logger.info({ transcript: ev.transcript }, 'heard');
      void report('heard', ev.transcript);
    });

    await session.start({ agent: new CompanionVoice({ companion, bridge, callId, timings, report }), room: ctx.room });
    logger.info({ companion: companion.id, callId, session: opened.health.sessionId }, 'call open');
    // Whoever placed the call, the companion speaks first: it picks up the person's call with its
    // own hello, or opens the one it placed. Its own words each time, read by its own voice.
    void speakFirst({ session, bridge, report, logger, stillFirst: () => timings.current === null, why: job.calledBy === 'companion'
      ? ['네가 건 전화를 받았어. 먼저 말해.', job.reason ? `건 이유: ${job.reason}` : ''].filter(Boolean).join(' ')
      : '사용자가 너한테 전화를 걸었고 방금 연결됐어. 전화 받는 사람으로서 먼저 한마디 해.' });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url))
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME,
    host: '127.0.0.1', port: Number(process.env.RUBATO_CALL_AGENT_PORT ?? 18791),
    // One person's calls on their own Mac: a busy Mac must not refuse the call.
    loadFunc: async () => 0, numIdleProcesses: 1 }));
