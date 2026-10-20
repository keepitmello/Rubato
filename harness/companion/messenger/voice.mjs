// Segno's voice replies: text in, an Ogg/Opus voice note out, through Fish Audio as Roo's are
// (~/.claude/roo-channel/plugins/telegram-daemon/tts-adapter.ts). The voice is a setting the person
// fills in (messenger settings `voice.voiceId`); until they do, a voice reply fails with that reason
// and no voice is picked for them.
//
// Roo synthesizes WAV and encodes Opus with ffmpeg; this asks Fish for Opus directly, so nothing
// outside Node is needed and the audio is still compressed once.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { messengerPaths, readFishKey, readMessengerSettings } from './store.mjs';

export const FISH_ENDPOINT = 'https://api.fish.audio/v1/tts';
// Roo's measured choices: `balanced` latency does not grow with length; temperature 0.3 made
// repeated takes steadier with no loss of expression (tts-adapter.ts).
export const FISH_LATENCY = 'balanced';
export const FISH_TEMPERATURE = 0.3;
export const VOICE_MAX_CHARS = 2000;
const OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 60_000;

export class VoiceError extends Error {
  constructor(message) { super(message); this.name = 'VoiceError'; }
}

/** The voice note's length from its last Ogg page: granule position (48 kHz) less Opus pre-skip. */
export function oggOpusSeconds(bytes) {
  const buffer = Buffer.from(bytes);
  const last = buffer.lastIndexOf('OggS');
  const head = buffer.indexOf('OpusHead');
  if (last < 0 || last + 14 > buffer.length) return undefined;
  const granule = Number(buffer.readBigUInt64LE(last + 6));
  const preSkip = head >= 0 && head + 12 <= buffer.length ? buffer.readUInt16LE(head + 10) : 0;
  const seconds = Math.round((granule - preSkip) / 48_000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function pruneOld(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (now - statSync(file).mtimeMs > OUTPUT_TTL_MS) rmSync(file, { force: true }); } catch {}
    }
  } catch {}
}

/**
 * One voice note for `text`: `{ path, durationSec? }`. Errors name what is missing (no voice chosen,
 * no key) and never carry the key.
 */
export async function synthesizeVoice(text, { env = process.env, fetch: call = globalThis.fetch, now = Date.now,
  baseUrl = env.RUBATO_FISH_API_URL || FISH_ENDPOINT } = {}) {
  const spoken = String(text ?? '').trim();
  if (!spoken) throw new VoiceError('nothing to say');
  if (spoken.length > VOICE_MAX_CHARS) throw new VoiceError(`too long for a voice note: ${spoken.length} characters (at most ${VOICE_MAX_CHARS})`);
  const { voice } = readMessengerSettings(env);
  if (!voice.voiceId) throw new VoiceError('no voice is chosen for Segno yet');
  const key = readFishKey(env);
  if (!key) throw new VoiceError('no Fish Audio key is set up');
  let response;
  try {
    response = await call(baseUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model: voice.model },
      body: JSON.stringify({ text: spoken, reference_id: voice.voiceId, format: 'opus', opus_bitrate: 48,
        latency: FISH_LATENCY, temperature: FISH_TEMPERATURE }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new VoiceError(`the voice request failed (${error?.name ?? 'Error'})`);
  }
  if (!response.ok) throw new VoiceError(`Fish Audio answered HTTP ${response.status}`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new VoiceError('Fish Audio returned no audio');
  if (audio.subarray(0, 4).toString('latin1') !== 'OggS') throw new VoiceError('Fish Audio did not return an Ogg/Opus voice note');
  const dir = messengerPaths(env).voice;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneOld(dir, now());
  const file = path.join(dir, `segno-${now()}-${Math.random().toString(36).slice(2, 8)}.ogg`);
  writeFileSync(file, audio, { mode: 0o600 });
  const durationSec = oggOpusSeconds(audio);
  return { path: file, ...(durationSec ? { durationSec } : {}) };
}
