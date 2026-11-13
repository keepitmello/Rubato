// Which companion a call reaches and how it sounds. Everything comes from the places that already
// own it: the registry (~/.rubato/companions.json) for the call bridge, and the companion's
// messenger settings for its voice, so a call speaks in the same voice as its voice replies. A
// companion without a chosen voice cannot be called; no voice is picked for it here.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { companionEnv, listCompanions } from '../registry.mjs';
import { readFishKey, readMessengerSettings } from '../messenger/store.mjs';
import { pronunciationText } from '../messenger/voice.mjs';

export class CallSetupError extends Error {
  constructor(message) { super(message); this.name = 'CallSetupError'; }
}

/** The OpenAI key the app's own voice input uses (~/.rubato/voice.json), else OPENAI_API_KEY. */
export function readOpenAiKey(env = process.env) {
  const file = env.RUBATO_VOICE_CONFIG ?? path.join(env.HOME ?? os.homedir(), '.rubato', 'voice.json');
  try {
    const key = JSON.parse(readFileSync(file, 'utf8')).openaiApiKey;
    if (typeof key === 'string' && key.trim()) return key.trim();
  } catch {}
  return env.OPENAI_API_KEY?.trim() || null;
}

/** The ElevenLabs key: ELEVENLABS_API_KEY, else ~/.config/elevenlabs/api_key (as Fish keeps ~/.config/fish-audio). */
export function readElevenLabsKey(env = process.env) {
  if (env.ELEVENLABS_API_KEY?.trim()) return env.ELEVENLABS_API_KEY.trim();
  try { return readFileSync(path.join(env.HOME ?? os.homedir(), '.config', 'elevenlabs', 'api_key'), 'utf8').trim() || null; }
  catch { return null; }
}

/**
 * Voice engines a call can use, all in the companion's own voice. The first is its voice-reply
 * setting; the others are there to compare by ear. ElevenLabs needs a key and a voice the person
 * chose there (`call.elevenlabsVoiceId` in the profile), since a Fish voice id means nothing to it.
 */
export function voiceChoices(companion, env = process.env) {
  const fish = [...new Set([companion.voice.model, 's2.1-pro', 'drama-3'])].map((model, at) => ({
    id: `fish:${model}`, provider: 'fish', model, voiceId: companion.voice.voiceId,
    label: at === 0 ? `Fish ${model} (기본)` : `Fish ${model}`, ready: true }));
  const key = readElevenLabsKey(env), voiceId = companion.elevenlabsVoiceId;
  const reason = !key ? 'ElevenLabs 키가 없어' : !voiceId ? `${companion.title}의 ElevenLabs 목소리가 없어` : null;
  const eleven = ['eleven_v4_turbo', 'eleven_v4'].map(model => ({
    id: `elevenlabs:${model}`, provider: 'elevenlabs', model, voiceId, label: `ElevenLabs ${model.replace('eleven_', '')}`,
    ready: !reason, ...(reason ? { reason } : {}) }));
  return [...fish, ...eleven];
}

/** Companions that can take a call now, and why the rest cannot. Never throws for one bad profile. */
export function callableCompanions(env = process.env) {
  return listCompanions(env).map(profile => {
    try { return { id: profile.id, title: profile.title, ready: true, ...describe(resolveCompanion(profile.id, env)) }; }
    catch (error) { return { id: profile.id, title: profile.title, ready: false, reason: error.message }; }
  });
}

const describe = companion => ({ voiceId: companion.voice.voiceId, model: companion.voice.model,
  voices: voiceChoices(companion).map(({ id, label, ready, reason }) => ({ id, label, ready, reason })) });

export function resolveCompanion(id, env = process.env) {
  const own = companionEnv(id, env);
  const title = own.RUBATO_COMPANION_TITLE;
  const call = JSON.parse(own.RUBATO_COMPANION_CALL || '{}');
  if (!call.enabled) throw new CallSetupError(`${title} has no call bridge turned on`);
  const { voice } = readMessengerSettings(own);
  if (!voice.voiceId) throw new CallSetupError(`no voice is chosen for ${title} yet`);
  const fishKey = readFishKey(own);
  if (!fishKey) throw new CallSetupError(`no Fish Audio key is set up for ${title}`);
  return {
    id, title,
    bridge: { url: `http://${call.host?.includes(':') ? `[${call.host}]` : call.host ?? '127.0.0.1'}:${call.port}`, token: call.token ?? null },
    voice, fishKey,
    userLabel: call.userLabel ?? null,
    elevenlabsVoiceId: typeof call.elevenlabsVoiceId === 'string' ? call.elevenlabsVoiceId : null,
    speakable: text => pronunciationText(text, own),
  };
}
