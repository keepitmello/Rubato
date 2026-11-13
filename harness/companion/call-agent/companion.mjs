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

/** Companions that can take a call now, and why the rest cannot. Never throws for one bad profile. */
export function callableCompanions(env = process.env) {
  return listCompanions(env).map(profile => {
    try { return { id: profile.id, title: profile.title, ready: true, ...describe(resolveCompanion(profile.id, env)) }; }
    catch (error) { return { id: profile.id, title: profile.title, ready: false, reason: error.message }; }
  });
}

const describe = companion => ({ voiceId: companion.voice.voiceId, model: companion.voice.model });

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
    speakable: text => pronunciationText(text, own),
  };
}
