import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CALL_SAY_TOOL, createCompanionCall } from '../../../pi-runtime/features/companion-home/call.mjs';
import { createBridge, createSpeechBetween, cutFrom, TALK_OVER_SECONDS } from '../bridge.mjs';
import { callableCompanions, resolveCompanion, voiceChoices } from '../companion.mjs';

// The companion's real call bridge on a fake session: `say` streams call_say the way a model
// writes it, `hang` leaves the turn unfinished.
async function companionSession(t, behaviour) {
  const home = mkdtempSync(path.join(tmpdir(), 'call-agent-'));
  const env = { HOME: home, RUBATO_COMPANION_HOME: home, RUBATO_PI_ROLE: 'companion', RUBATO_COMPANION_ID: 'other', RUBATO_COMPANION_TITLE: 'Other' };
  const handlers = new Map(), heard = [], system = [];
  let busy = false, aborts = 0;
  const ctx = { sessionManager: { getSessionId: () => 'native' }, model: { id: 'fake' }, isIdle: () => !busy,
    abort: async () => { aborts++; busy = false; }, ui: { notify() {} } };
  const emit = (name, data = {}) => { if (name === 'agent_settled') busy = false; for (const handler of handlers.get(name) ?? []) handler(data, ctx); };
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool() {},
    sendMessage(message) { system.push(message.details?.text ?? ''); emit('message_start', { message: { role: 'custom', ...message } }); },
    sendUserMessage(content) {
      heard.push(content); busy = true; emit('message_start', { message: { role: 'user', content } });
      setImmediate(() => behaviour(emit));
    },
  };
  const bridge = createCompanionCall(pi, { env, config: { enabled: true, host: '127.0.0.1', port: 0, turnTimeoutMs: 5000 } });
  await bridge.start(ctx);
  t.after(async () => { await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${bridge.address().port}`, heard, system, home, aborts: () => aborts };
}

const say = text => emit => {
  for (let end = 1; end <= text.length; end++) emit('message_update', { assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0,
    partial: { content: [{ type: 'toolCall', name: CALL_SAY_TOOL, arguments: { text: text.slice(0, end) } }] } } });
  emit('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0,
    toolCall: { type: 'toolCall', id: 'say-1', name: CALL_SAY_TOOL, arguments: { text } } } });
  emit('agent_settled');
};

test('a heard turn reaches the companion as voice and its sentences come back in order', async t => {
  const companion = await companionSession(t, say('응, 들려! 나 여기 있어.'));
  const client = createBridge({ url: companion.url });
  const call = await client.open('room-1');
  assert.equal(call.health.sessionId, 'native');
  const events = [];
  for await (const event of client.turn('루야 들려?')) events.push(event);
  assert.deepEqual(events.filter(event => event.t === 'delta').map(event => event.text), ['응, 들려! ', '나 여기 있어.']);
  assert.equal(events.at(-1).t, 'done');
  assert.deepEqual(companion.heard, ['[voice] 루야 들려?']);
  await call.end();
  assert.match(companion.system.at(-1), /^\[voice\] 통화 종료/);
});

test('cutting a turn off on this side ends that turn and leaves the companion working', async t => {
  const companion = await companionSession(t, () => {});
  const client = createBridge({ url: companion.url });
  const controller = new AbortController();
  const turn = client.turn('긴 질문', { turnId: 'cut-1', signal: controller.signal });
  const first = turn.next();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(first);
  let receipt;
  while (!receipt) {
    await new Promise(resolve => setTimeout(resolve, 20));
    const file = readdirSync(path.join(companion.home, 'call', 'turns')).map(name => path.join(companion.home, 'call', 'turns', name))[0];
    if (JSON.parse(readFileSync(file, 'utf8')).status !== 'running') receipt = path.basename(file);
  }
  assert.equal(companion.aborts(), 0);
  assert.equal(JSON.parse(readFileSync(path.join(companion.home, 'call', 'turns', receipt), 'utf8')).status, 'interrupted');
});

test('a call reaches only companions with a bridge and a chosen voice, in that voice', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'call-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = (id, call) => {
    const home = path.join(root, id);
    mkdirSync(path.join(home, 'messenger'), { recursive: true });
    return { id, title: id, home, memoryAgent: id, call };
  };
  const voiced = profile('voiced', { enabled: true, port: 18001, elevenlabsVoiceId: 'eleven-voice',
    companionLabel: '보이스', userLabel: '우용이', keywords: ['세뇨', ' 미카엘 ', '보이스', 7] });
  const silent = profile('silent', { enabled: true, port: 18002 });
  const closed = profile('closed', { enabled: false });
  const voiceId = '3c7ee7e408104d76a777ebaadc201896';
  for (const item of [voiced, closed])
    writeFileSync(path.join(item.home, 'messenger', 'settings.json'), JSON.stringify({ voice: { voiceId, model: 's2.1-pro' } }));
  const file = path.join(root, 'companions.json');
  writeFileSync(file, JSON.stringify({ companions: [voiced, silent, closed] }));
  const env = { HOME: root, RUBATO_COMPANIONS_FILE: file, FISH_API_KEY: 'fish-key' };

  const resolved = resolveCompanion('voiced', env);
  assert.equal(resolved.bridge.url, 'http://127.0.0.1:18001');
  assert.deepEqual(resolved.keywords, ['voiced', '보이스', '우용이', '세뇨', '미카엘'], 'names transcription should expect, once each');
  assert.deepEqual([resolved.voice.voiceId, resolved.voice.model, resolved.fishKey], [voiceId, 's2.1-pro', 'fish-key']);
  assert.throws(() => resolveCompanion('silent', env), /no voice is chosen for silent/);
  assert.throws(() => resolveCompanion('closed', env), /closed has no call bridge/);
  assert.deepEqual(callableCompanions(env).map(item => [item.id, item.ready]),
    [['segno', false], ['voiced', true], ['silent', false], ['closed', false]]);
});

test('a call speaks in the companion voice by default; ElevenLabs needs its own key and voice', t => {
  const companion = { title: 'Roo', voice: { voiceId: 'fish-voice', model: 's2.1-pro-free' }, elevenlabsVoiceId: null };
  const home = mkdtempSync(path.join(tmpdir(), 'call-voices-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const choices = voiceChoices(companion, { HOME: home });
  assert.deepEqual(choices.map(item => item.id), ['fish:s2.1-pro-free', 'fish:s2.1-pro', 'fish:drama-3', 'elevenlabs:eleven_v4_turbo', 'elevenlabs:eleven_v4']);
  assert.ok(choices.filter(item => item.provider === 'fish').every(item => item.ready && item.voiceId === 'fish-voice'));
  assert.equal(choices.at(-1).reason, 'ElevenLabs 키가 없어');
  assert.equal(voiceChoices(companion, { HOME: home, ELEVENLABS_API_KEY: 'k' }).at(-1).reason, 'Roo의 ElevenLabs 목소리가 없어');
  const ready = voiceChoices({ ...companion, elevenlabsVoiceId: 'eleven-voice' }, { HOME: home, ELEVENLABS_API_KEY: 'k' });
  assert.deepEqual(ready.slice(3).map(item => [item.ready, item.voiceId]), [[true, 'eleven-voice'], [true, 'eleven-voice']]);
  assert.equal(voiceChoices({ ...companion, voice: { ...companion.voice, model: 'drama-3' } }, { HOME: home }).filter(item => item.provider === 'fish').length, 2);
});

test('cutting in sends the cut reply, how long it played and this voice\'s pace, from the chat context LiveKit keeps', async t => {
  const { llm } = await import('@livekit/agents');
  const message = (role, content, { interrupted = false, from, to } = {}) => llm.ChatMessage.create({ role, content, interrupted,
    ...(from !== undefined ? { metrics: { startedSpeakingAt: from, stoppedSpeakingAt: to } } : {}) });
  const items = [message('user', '루야 들려?'), message('assistant', '응, 들려! 나 여기 있어.', { from: 10, to: 13 }),
    message('user', '피곤해'), message('assistant', '헐. 오늘은 좀 자자!', { interrupted: true, from: 20, to: 22 }), message('user', '아까')];
  assert.deepEqual(cutFrom(items), { said: '헐. 오늘은 좀 자자!', heardSeconds: 2 - TALK_OVER_SECONDS,
    pace: [{ text: '응, 들려! 나 여기 있어.', seconds: 3 }] });
  assert.equal(cutFrom([message('user', 'a'), message('assistant', '끝까지 다 들림', { from: 1, to: 2 }), message('user', 'b')]), null);
  assert.equal(cutFrom([message('assistant', '앞 통화에서 끊김', { interrupted: true, from: 1, to: 2 }), message('user', 'a'),
    message('assistant', '다 들림', { from: 3, to: 4 }), message('user', 'b')]), null, 'only the reply right before these words counts');
  assert.equal(cutFrom([message('assistant', '시각 없음', { interrupted: true }), message('user', 'a')]), null);

  const companion = await companionSession(t, say('아 미안, 말해.'));
  const client = createBridge({ url: companion.url });
  for await (const _ of client.turn('잠깐만', { cut: cutFrom(items) }));
  assert.deepEqual(companion.heard, ['[voice] 잠깐만'], 'nothing is added to what the person said');
});

test('words the companion says while it works play in order, and wait while the person talks', async t => {
  const companion = await companionSession(t, emit => {
    emit('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'first', name: CALL_SAY_TOOL, arguments: { text: '잠깐만, 볼게.' } } } });
    emit('tool_execution_start', { toolName: 'bash', toolCallId: 'look' });
    setTimeout(() => {
      emit('tool_execution_end', { toolName: 'bash', toolCallId: 'look' });
      emit('message_start', { message: { role: 'assistant', content: [] } });
      say('봤어. 정의는 하나도 없더라.')(emit);
    }, 30);
  });
  const spoken = [];
  const between = createSpeechBetween({ speak: async stream => {
    const parts = [];
    spoken.push(parts);
    for await (const part of stream) parts.push(part);
  } });
  between.personSpeaking(true);
  const client = createBridge({ url: companion.url });
  const call = await client.open('room-between', { onEvent: event => between.event(event) });
  const answer = [];
  for await (const event of client.turn('개발방 읽어봐')) if (event.t === 'delta') answer.push(event.text);
  assert.deepEqual(answer, ['잠깐만, 볼게.']);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(spoken, [], 'nothing starts while the person is talking');
  between.personSpeaking(false);
  for (const end = Date.now() + 2000; spoken.flat().join('') !== '봤어. 정의는 하나도 없더라.';) {
    if (Date.now() > end) assert.fail(`never spoken; got ${JSON.stringify(spoken)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(spoken, [['봤어. ', '정의는 하나도 없더라.']]);
  assert.equal(companion.aborts(), 0);
  await call.end();
});
