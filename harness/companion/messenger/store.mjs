// The messenger's files: what it is connected to, who the user is, what Segno wants to send and
// what the user decided. They live next to the companion's own files, so everything about Segno
// is in one folder.
//
//   <companion home>/messenger/
//     settings.json        what Settings › Companion saved (the app writes it; the service reads it)
//     secret.json          the bot token, 0600
//     intent.json          one thing the app asked the service to do (pair, unpair, create the bot)
//     handoff.json         where the service is with that intent
//     pair.json            who the user's chat is, or the code waiting for it
//     outbox/<id>.json     a message Segno wrote: queued, held for approval, sent or refused
//     decisions/<id>.json  the user's answer to one held message, written by the app or Telegram
//     state.json           the update offset and the turns already answered
//     sent.jsonl           every message that reached Telegram, one line each (Segno's sent-message check reads it)
//     received/            photos and files the person sent, saved for Segno to see and open
//     stt/                 each voice message: its audio and what it said (Roo's STT archive)
//     voice/               Segno's own voice replies, kept a day
//     fish-api-key         the Fish Audio key for voice replies, 0600, if the person gave one here
//
// Two processes touch these files: the engine's service and the app's Settings page. Each file has
// one writer, so neither has to lock: the app writes settings, intent and decisions; the service
// writes the secret, pairing, outbox state, handoff and state. Every write is a rename, so a reader
// sees a whole file or the old one.
import { randomInt, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { companionHome } from '../companion.mjs';

/**
 * Whether the product runs the Telegram messenger. Off for now (intent companion-segno rev 9, user
 * item cc61d883: "그냥 텔레 비활성화 하자 제품에서. 아직 한계가 있어보이네"): the engine starts no
 * messenger, the settings tool and Settings › Companion offer no Telegram, and Segno speaks to the
 * person only in the app (`reply`). The code stays for later; this one switch brings the
 * engine and the settings back. Segno's Telegram tools follow the runtime's own option
 * (pi-runtime companion-messenger `telegram`), since the runtime build cannot reach this file.
 */
export const TELEGRAM_ENABLED = false;

export const MESSENGER_LIMITS = Object.freeze({
  /** Telegram's own ceiling for one message. */
  textChars: 4096,
  /** A message Segno wrote and the user may forward. */
  heldTextChars: 4000,
  /** Held messages waiting for an answer at once. */
  heldMax: 50,
  /** Sent or refused outbox rows kept for the settings page. */
  historyMax: 200,
});

export function messengerHome(env = process.env) {
  return path.join(companionHome(env), 'messenger');
}

export function messengerPaths(env = process.env) {
  const home = messengerHome(env);
  return {
    home,
    settings: path.join(home, 'settings.json'),
    secret: path.join(home, 'secret.json'),
    intent: path.join(home, 'intent.json'),
    handoff: path.join(home, 'handoff.json'),
    pair: path.join(home, 'pair.json'),
    state: path.join(home, 'state.json'),
    outbox: path.join(home, 'outbox'),
    decisions: path.join(home, 'decisions'),
    sent: path.join(home, 'sent.jsonl'),
    received: path.join(home, 'received'),
    stt: path.join(home, 'stt'),
    voice: path.join(home, 'voice'),
    fishKey: path.join(home, 'fish-api-key'),
  };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function writeJson(file, value, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode });
  renameSync(temporary, file);
}

function readDirJson(dir) {
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const value = readJson(path.join(dir, name));
    if (value && typeof value === 'object') rows.push(value);
  }
  return rows;
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────

/** Fish Audio's model for Segno's voice replies (Roo's tts-adapter.ts FISH_DEFAULT_MODEL). */
export const DEFAULT_VOICE_MODEL = 's2.1-pro-free';
export const DEFAULT_VOICE_TEMPERATURE = 0.3;

export const DEFAULT_MESSENGER_SETTINGS = Object.freeze({
  enabled: true,
  /** Ask before sending to anyone but the user. Off only if the person turns it off. */
  approvalRequired: true,
  /**
   * Segno's voice for voice replies: a Fish Audio voice id. None until the person picks one, and
   * until then a voice reply says so instead of speaking in a voice nobody chose.
   */
  voice: Object.freeze({ voiceId: null, model: DEFAULT_VOICE_MODEL, temperature: DEFAULT_VOICE_TEMPERATURE }),
});

const VOICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function normalizeMessengerSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  const voice = input.voice && typeof input.voice === 'object' ? input.voice : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_MESSENGER_SETTINGS.enabled,
    approvalRequired: typeof input.approvalRequired === 'boolean' ? input.approvalRequired : DEFAULT_MESSENGER_SETTINGS.approvalRequired,
    voice: {
      voiceId: typeof voice.voiceId === 'string' && VOICE_ID.test(voice.voiceId) ? voice.voiceId : null,
      model: typeof voice.model === 'string' && voice.model.trim() ? voice.model.trim() : DEFAULT_VOICE_MODEL,
      temperature: typeof voice.temperature === 'number' && Number.isFinite(voice.temperature) && voice.temperature >= 0
        ? voice.temperature : DEFAULT_VOICE_TEMPERATURE,
    },
  };
}

export function readMessengerSettings(env = process.env) {
  return normalizeMessengerSettings(readJson(messengerPaths(env).settings));
}

export function writeMessengerSettings(patch, env = process.env) {
  if (!patch || typeof patch !== 'object') throw new TypeError('settings patch must be an object');
  for (const field of ['enabled', 'approvalRequired'])
    if (patch[field] !== undefined && typeof patch[field] !== 'boolean') throw new TypeError(`${field} must be true or false`);
  if (patch.voice !== undefined) {
    if (!patch.voice || typeof patch.voice !== 'object') throw new TypeError('voice must be an object');
    const { voiceId, model, temperature } = patch.voice;
    if (voiceId !== undefined && voiceId !== null && !(typeof voiceId === 'string' && VOICE_ID.test(voiceId)))
      throw new TypeError('voice.voiceId must be a Fish Audio voice id or null');
    if (model !== undefined && !(typeof model === 'string' && model.trim() && model.length <= 100))
      throw new TypeError('voice.model must be a Fish Audio model name');
    if (temperature !== undefined && !(typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0))
      throw new TypeError('voice.temperature must be a nonnegative finite number');
  }
  const current = readMessengerSettings(env);
  const next = normalizeMessengerSettings({ ...current, ...patch, voice: { ...current.voice, ...patch.voice } });
  writeJson(messengerPaths(env).settings, next, 0o600);
  return next;
}

// ── the bot token ────────────────────────────────────────────────────────────────────────────

export function readSecret(env = process.env) {
  const value = readJson(messengerPaths(env).secret);
  return typeof value?.token === 'string' && value.token ? value : undefined;
}

export function writeSecret(token, env = process.env) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new TypeError('token must be a Telegram bot token');
  const file = messengerPaths(env).secret;
  writeJson(file, { token }, 0o600);
  return { token };
}

export function clearSecret(env = process.env) {
  rmSync(messengerPaths(env).secret, { force: true });
}

/** The bot the person made in Telegram, as Settings shows it: its token, name and username. */
export function readBot(env = process.env) {
  const value = readJson(messengerPaths(env).secret);
  return {
    token: typeof value?.token === 'string' && value.token ? value.token : null,
    ...(typeof value?.username === 'string' && value.username ? { username: value.username } : {}),
    ...(typeof value?.name === 'string' && value.name ? { name: value.name } : {}),
  };
}

export function writeBotIdentity({ username, name } = {}, env = process.env) {
  const current = readSecret(env);
  if (!current) throw new TypeError('no bot token is stored yet');
  writeJson(messengerPaths(env).secret, {
    token: current.token,
    ...(typeof username === 'string' && username ? { username } : {}),
    ...(typeof name === 'string' && name ? { name } : {}),
  });
}

// ── the Fish Audio key for voice replies ─────────────────────────────────────────────────────

/** Keeps the Fish Audio key for voice replies (0600, like the bot token). */
export function writeFishKey(key, env = process.env) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(key.trim())) throw new TypeError('that does not look like a Fish Audio API key');
  const file = messengerPaths(env).fishKey;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, key.trim() + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

export function clearFishKey(env = process.env) {
  rmSync(messengerPaths(env).fishKey, { force: true });
}

/** The Fish Audio key voice replies use: FISH_API_KEY, else the saved one; null when neither. */
export function readFishKey(env = process.env) {
  const fromEnv = env.FISH_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try { return readFileSync(messengerPaths(env).fishKey, 'utf8').trim() || null; } catch { return null; }
}

// ── pairing ──────────────────────────────────────────────────────────────────────────────────

/** No 0/O/1/I: the person types this on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newPairingCode(random = (max) => randomInt(max)) {
  let code = '';
  for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return code;
}

export function readPairing(env = process.env) {
  const value = readJson(messengerPaths(env).pair);
  const status = value?.status === 'paired' || value?.status === 'pending' ? value.status : 'unpaired';
  const chat = value?.chat && typeof value.chat === 'object' && value.chat.chatId !== undefined ? value.chat : undefined;
  return {
    status,
    ...(typeof value?.code === 'string' && value.code ? { code: value.code } : {}),
    ...(typeof value?.requestedAt === 'string' ? { requestedAt: value.requestedAt } : {}),
    ...(chat && status === 'paired' ? { chat } : {}),
  };
}

export function writePairing(value, env = process.env) {
  writeJson(messengerPaths(env).pair, value);
}

/** The chat that counts as the user. Nothing else does. */
export function pairedChatId(env = process.env) {
  const pairing = readPairing(env);
  return pairing.status === 'paired' ? String(pairing.chat.chatId) : undefined;
}

// ── what the app asked the service to do ────────────────────────────────────────────────────

/**
 * The app's one request at a time: `{ action: 'pair' | 'unpair' | 'create-bot', at, name?, username? }`.
 * The service records the `at` it finished in handoff.json, so a request runs once even across a
 * restart. `action: 'pair'` asks for a fresh code.
 */
export function readIntent(env = process.env) {
  const value = readJson(messengerPaths(env).intent);
  return value && typeof value === 'object' && typeof value.action === 'string' && typeof value.at === 'string' ? value : undefined;
}

/** `at` lets the service answer its own request file without the request looking new again. */
export function writeIntent(intent, env = process.env, { at } = {}) {
  writeJson(messengerPaths(env).intent, { ...intent, at: at ?? new Date().toISOString() });
  return readIntent(env);
}

export function readHandoff(env = process.env) {
  const value = readJson(messengerPaths(env).handoff);
  return {
    ...(typeof value?.intentAt === 'string' ? { intentAt: value.intentAt } : {}),
    ...(typeof value?.result === 'string' ? { result: value.result } : {}),
    ...(typeof value?.error === 'string' ? { error: value.error } : {}),
  };
}

export function writeHandoff(value, env = process.env) {
  writeJson(messengerPaths(env).handoff, value);
}

// ── outbox ──────────────────────────────────────────────────────────────────────────────────

const OUTBOX_STATES = new Set(['queued', 'held', 'sent', 'rejected', 'failed']);
export const OUTBOX_STATE_NAMES = Object.freeze([...OUTBOX_STATES]);

export function newOutboxId() {
  return `m_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

/** What one outbox row asks Telegram for: a message (text, files, voice), a reaction or an edit. */
export const OUTBOX_OPS = Object.freeze(['send', 'react', 'edit']);
/** Files one message may carry; Roo's reply sends each as its own photo or document. */
export const FILES_MAX = 10;

/**
 * What Segno wrote, waiting to go out. `target` is `'user'` or a chat it addresses:
 * `{ chatId, name? }`. The tool that writes this never sends anything itself.
 *
 *   op 'send'   text and/or files and/or a voice note (`voice`: false, true = text and voice, 'only')
 *   op 'react'  one emoji on `messageId`
 *   op 'edit'   new `text` for Segno's own `messageId`
 */
export function enqueueMessage({ text, target, source = 'tool', heldReason, op = 'send', files, voice, voiceText, sanitize,
  emoji, messageId, disableNotification } = {}, env = process.env) {
  if (!OUTBOX_OPS.includes(op)) throw new TypeError(`op must be one of ${OUTBOX_OPS.join(', ')}`);
  const hasText = typeof text === 'string' && text.trim() !== '';
  if (text !== undefined && !hasText) throw new TypeError('text must be a non-empty string');
  if (hasText && text.length > MESSENGER_LIMITS.heldTextChars) throw new TypeError(`text holds at most ${MESSENGER_LIMITS.heldTextChars} characters`);
  if (voiceText !== undefined && !(typeof voiceText === 'string' && voiceText.trim()))
    throw new TypeError('voice_text must be a non-empty string');
  if (voice !== undefined && voice !== true && voice !== false && voice !== 'only') throw new TypeError('voice must be true, false or "only"');
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length > FILES_MAX) throw new TypeError(`files must be a list of at most ${FILES_MAX} paths`);
    for (const file of files) if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('each file must be an absolute path');
  }
  const ids = messageId === undefined ? undefined : Number(messageId);
  if (op === 'send' && !hasText && !voiceText && !files?.length) throw new TypeError('a message needs text, voice_text or files');
  if (op === 'react' && !(typeof emoji === 'string' && emoji.trim())) throw new TypeError('a reaction needs an emoji');
  if ((op === 'react' || op === 'edit') && !Number.isInteger(ids)) throw new TypeError(`${op === 'react' ? 'a reaction' : 'an edit'} needs the message id`);
  if (op === 'edit' && !hasText) throw new TypeError('an edit needs the new text');
  if (target !== 'user' && !(target && typeof target === 'object' && target.chatId !== undefined))
    throw new TypeError("target must be 'user' or an object with a chatId");
  const rows = listOutbox(env);
  if (rows.filter((row) => row.state === 'held').length >= MESSENGER_LIMITS.heldMax)
    throw new Error(`too many messages already wait for the user (${MESSENGER_LIMITS.heldMax})`);
  const row = {
    id: newOutboxId(),
    state: 'queued',
    ...(op === 'send' ? {} : { op }),
    ...(hasText ? { text } : {}),
    ...(files?.length ? { files: [...files] } : {}),
    ...(voice === true || voice === 'only' ? { voice } : {}),
    ...(voiceText ? { voiceText } : {}),
    ...(sanitize === false ? { sanitize: false } : {}),
    ...(disableNotification === true ? { disableNotification: true } : {}),
    ...(op === 'react' ? { emoji: emoji.trim() } : {}),
    ...(ids === undefined ? {} : { messageId: ids }),
    target: target === 'user' ? 'user' : { chatId: String(target.chatId), ...(target.name ? { name: target.name } : {}) },
    source,
    createdAt: new Date().toISOString(),
    ...(heldReason ? { heldReason } : {}),
  };
  writeJson(path.join(messengerPaths(env).outbox, `${row.id}.json`), row);
  pruneOutbox(env);
  return row;
}

export function listOutbox(env = process.env) {
  return readDirJson(messengerPaths(env).outbox).filter((row) => typeof row.id === 'string' && OUTBOX_STATES.has(row.state));
}

export function readOutboxRow(id, env = process.env) {
  return readJson(path.join(messengerPaths(env).outbox, `${id}.json`));
}

/** The service's own transition of one row; the tool that queued it never writes it again. */
export function updateOutboxRow(id, patch, env = process.env) {
  const current = readOutboxRow(id, env);
  if (!current) throw new TypeError(`unknown outbox row: ${id}`);
  const next = { ...current, ...patch };
  if (!OUTBOX_STATES.has(next.state)) throw new TypeError(`unknown outbox state: ${next.state}`);
  writeJson(path.join(messengerPaths(env).outbox, `${id}.json`), next);
  return next;
}

function pruneOutbox(env) {
  const dir = messengerPaths(env).outbox;
  const done = listOutbox(env).filter((row) => row.state !== 'queued' && row.state !== 'held')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const row of done.slice(MESSENGER_LIMITS.historyMax)) rmSync(path.join(dir, `${row.id}.json`), { force: true });
}

// ── the user's answers ─────────────────────────────────────────────────────────────────────

/**
 * The person's answer to one held message. An approval may carry `text`: the message as the person
 * edited it, which is what goes out.
 */
export function writeDecision(id, decision, { by = 'app', text } = {}, env = process.env) {
  if (decision !== 'approve' && decision !== 'reject') throw new TypeError('decision must be approve or reject');
  if (text !== undefined) {
    if (decision !== 'approve') throw new TypeError('only an approval carries edited text');
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('edited text must not be empty');
    if (text.length > MESSENGER_LIMITS.heldTextChars) throw new TypeError(`text holds at most ${MESSENGER_LIMITS.heldTextChars} characters`);
  }
  writeJson(path.join(messengerPaths(env).decisions, `${id}.json`),
    { id, decision, by, at: new Date().toISOString(), ...(text === undefined ? {} : { text }) });
  return { id, decision };
}

export function readDecision(id, env = process.env) {
  return readJson(path.join(messengerPaths(env).decisions, `${id}.json`));
}

export function listDecisions(env = process.env) {
  return readDirJson(messengerPaths(env).decisions).filter((row) => typeof row.id === 'string');
}

/** Drops a decision once its row is settled, so a later row with the same id cannot inherit it. */
export function clearDecision(id, env = process.env) {
  rmSync(path.join(messengerPaths(env).decisions, `${id}.json`), { force: true });
}

// ── the service's own bookkeeping ───────────────────────────────────────────────────────────

export function readState(env = process.env) {
  const value = readJson(messengerPaths(env).state);
  const transcript = value?.transcript && typeof value.transcript === 'object' ? value.transcript : undefined;
  return {
    ...(Number.isInteger(value?.offset) ? { offset: value.offset } : {}),
    // The companion transcript already accounted for: `offset` bytes of `file`, the run state at
    // that point (sync.mjs) and how many parts of the next text already went out. A file that is
    // waiting to appear keeps `file: null` and takes everything it gets. A cursor without an
    // offset is from before offsets, and reads as "take what is there as read".
    ...(transcript ? { transcript: {
      file: typeof transcript.file === 'string' ? transcript.file : null,
      ...(Number.isInteger(transcript.offset) && transcript.offset >= 0 ? { offset: transcript.offset } : {}),
      ...(transcript.run && typeof transcript.run === 'object' ? { run: transcript.run } : {}),
      ...(Number.isInteger(transcript.sentParts) && transcript.sentParts > 0 ? { sentParts: transcript.sentParts } : {}),
    } } : {}),
    // The person's latest Telegram message: where a reaction lands when Segno names none.
    ...(value?.lastIncoming && typeof value.lastIncoming === 'object' && value.lastIncoming.messageId !== undefined
      ? { lastIncoming: { chatId: String(value.lastIncoming.chatId), messageId: value.lastIncoming.messageId } } : {}),
  };
}

export function writeState(patch, env = process.env) {
  const next = { ...readState(env), ...patch };
  writeJson(messengerPaths(env).state, next);
  return next;
}

/** What a row asks for, in the words the person reads on an approval card or in Settings. */
export function describeRow(row) {
  if (row?.op === 'react') return `반응 ${row.emoji} — 메시지 ${row.messageId}`;
  if (row?.op === 'edit') return `메시지 ${row.messageId} 고치기:\n${row.text}`;
  const parts = [];
  if (row?.voice === 'only') parts.push(`(음성) ${row.voiceText ?? row.text ?? ''}`.trim());
  else {
    if (row?.text) parts.push(row.text);
    if (row?.voice === true) parts.push(`(음성도 함께${row.voiceText ? `: ${row.voiceText}` : ''})`);
  }
  for (const file of row?.files ?? []) parts.push(`(파일: ${path.basename(file)})`);
  return parts.join('\n');
}

// ── what reached Telegram ───────────────────────────────────────────────────────────────────

/**
 * One line per message that reached Telegram, for Segno's sent-message check (Roo's sent.sh):
 * `{ at, chatId, toUser, text, via: 'auto' | 'tool', media? }`. `auto` is an answer the sync sent,
 * `tool` one Segno sent with telegram_send or one the person approved.
 */
export function recordSent({ at = new Date().toISOString(), chatId, toUser, text, via, media }, env = process.env) {
  const file = messengerPaths(env).sent;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify({ at, chatId: String(chatId), toUser: toUser === true, text: String(text ?? ''), via,
    ...(media ? { media } : {}) }) + '\n', { mode: 0o600 });
}

// ── what Settings › Companion shows ─────────────────────────────────────────────────────────

/** The Telegram connection for the settings page: everything it holds, and what can be acted on. */
export function messengerStatus(env = process.env) {
  const rows = listOutbox(env);
  const visible = (row) => ({
    id: row.id,
    text: describeRow(row),
    target: row.target === 'user' ? null : row.target,
    createdAt: row.createdAt,
    ...(row.source ? { source: row.source } : {}),
  });
  return {
    settings: readMessengerSettings(env),
    fishKey: readFishKey(env),
    bot: readBot(env),
    pairing: readPairing(env),
    handoff: readHandoff(env),
    home: messengerPaths(env).home,
    waiting: rows.filter((row) => row.state === 'held' || row.state === 'queued').map(visible),
    recent: rows.filter((row) => row.state === 'sent' || row.state === 'rejected' || row.state === 'failed')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20)
      .map((row) => ({ ...visible(row), state: row.state })),
  };
}
