// The messenger's files: what it is connected to, who the user is, what Segno wants to send and
// what the user decided. They live next to the companion's own files, so everything about Segno
// is in one folder.
//
//   <companion home>/messenger/
//     settings.json        what Settings › Companion saved (the app writes it; the service reads it)
//     secret.json          the bot token, 0600, never handed back in full
//     intent.json          one thing the app asked the service to do (pair, unpair, create the bot)
//     handoff.json         where the service is with that intent
//     pair.json            who the user's chat is, or the code waiting for it
//     outbox/<id>.json     a message Segno wrote: queued, held for approval, sent or refused
//     decisions/<id>.json  the user's answer to one held message, written by the app or Telegram
//     state.json           the update offset and the turns already answered
//
// Two processes touch these files: the engine's service and the app's Settings page. Each file has
// one writer, so neither has to lock: the app writes settings, intent and decisions; the service
// writes the secret, pairing, outbox state, handoff and state. Every write is a rename, so a reader
// sees a whole file or the old one.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { companionHome } from '../companion.mjs';

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

export const DEFAULT_MESSENGER_SETTINGS = Object.freeze({
  enabled: true,
  /** Ask before sending to anyone but the user. Off only if the person turns it off. */
  approvalRequired: true,
});

export function normalizeMessengerSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_MESSENGER_SETTINGS.enabled,
    approvalRequired: typeof input.approvalRequired === 'boolean' ? input.approvalRequired : DEFAULT_MESSENGER_SETTINGS.approvalRequired,
  };
}

export function readMessengerSettings(env = process.env) {
  return normalizeMessengerSettings(readJson(messengerPaths(env).settings));
}

export function writeMessengerSettings(patch, env = process.env) {
  if (!patch || typeof patch !== 'object') throw new TypeError('settings patch must be an object');
  for (const field of ['enabled', 'approvalRequired'])
    if (patch[field] !== undefined && typeof patch[field] !== 'boolean') throw new TypeError(`${field} must be true or false`);
  const next = normalizeMessengerSettings({ ...readMessengerSettings(env), ...patch });
  writeJson(messengerPaths(env).settings, next, 0o600);
  return next;
}

// ── the bot token ────────────────────────────────────────────────────────────────────────────

/** A token's bot id and its last four characters: enough to tell two bots apart, never enough to use one. */
export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return null;
  const [id, secret] = token.split(':');
  if (!secret) return `${token.slice(0, 4)}…`;
  return `${id}:…${secret.slice(-4)}`;
}

export function readSecret(env = process.env) {
  const value = readJson(messengerPaths(env).secret);
  return typeof value?.token === 'string' && value.token ? value : undefined;
}

export function writeSecret(token, env = process.env) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new TypeError('token must be a Telegram bot token');
  const file = messengerPaths(env).secret;
  writeJson(file, { token }, 0o600);
  return { token: maskToken(token) };
}

export function clearSecret(env = process.env) {
  rmSync(messengerPaths(env).secret, { force: true });
}

/** The bot the person made in Telegram, as Settings shows it: name and username, never the token. */
export function readBot(env = process.env) {
  const value = readJson(messengerPaths(env).secret);
  return {
    masked: maskToken(value?.token),
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

/**
 * What Segno wrote, waiting to go out. `target` is `'user'` or a chat it addresses:
 * `{ chatId, name? }`. The tool that writes this never sends anything itself.
 */
export function enqueueMessage({ text, target, source = 'tool', heldReason }, env = process.env) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('text must be a non-empty string');
  if (text.length > MESSENGER_LIMITS.heldTextChars) throw new TypeError(`text holds at most ${MESSENGER_LIMITS.heldTextChars} characters`);
  if (target !== 'user' && !(target && typeof target === 'object' && target.chatId !== undefined))
    throw new TypeError("target must be 'user' or an object with a chatId");
  const rows = listOutbox(env);
  if (rows.filter((row) => row.state === 'held').length >= MESSENGER_LIMITS.heldMax)
    throw new Error(`too many messages already wait for the user (${MESSENGER_LIMITS.heldMax})`);
  const row = {
    id: newOutboxId(),
    state: 'queued',
    text,
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
    // The companion transcript already accounted for: `seen` entries of `file`. A file that is
    // waiting to appear keeps `file: null` and takes everything it gets.
    ...(transcript ? { transcript: {
      file: typeof transcript.file === 'string' ? transcript.file : null,
      seen: Number.isInteger(transcript.seen) ? transcript.seen : null,
    } } : {}),
  };
}

export function writeState(patch, env = process.env) {
  const next = { ...readState(env), ...patch };
  writeJson(messengerPaths(env).state, next);
  return next;
}

// ── what Settings › Companion shows ─────────────────────────────────────────────────────────

/** The Telegram connection for the settings page: never the token, always what can be acted on. */
export function messengerStatus(env = process.env) {
  const rows = listOutbox(env);
  const visible = (row) => ({
    id: row.id,
    text: row.text,
    target: row.target === 'user' ? null : row.target,
    createdAt: row.createdAt,
    ...(row.source ? { source: row.source } : {}),
  });
  return {
    settings: readMessengerSettings(env),
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
