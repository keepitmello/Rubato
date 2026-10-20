// The companion (Segno): one always-on conversation above the leads. This module is the one
// place that knows where its files live and what they hold; the engine keeper, the role prompt
// and the app's Companion settings page all read and write through it.
//
//   ~/.rubato/companion/                 the companion's home and its conversation's folder
//     settings.json                      what the person chose in Settings › Companion
//     state.json                         which conversation is the companion (written by the keeper)
//     prompt/<piece>.md                  the person's version of one prompt piece
//     prompt/.base/<piece>.md            the product default that version was copied from
//
// Each prompt piece has a product default (harness/prompts/companion/<piece>.pi.md). A piece the
// person rewrote is read from prompt/<piece>.md; every other piece keeps following the default,
// so an update to Rubato still reaches the pieces nobody touched. The tools piece describes the
// real tools and moves with the code, so it has no personal version.
//
// A new home starts with the person's own copy of who Segno is (SEEDED_PIECES): setup copies the
// default into prompt/<piece>.md when that file is absent, and keeps the text it copied in
// prompt/.base/<piece>.md. The base is outside what the prompt composer reads, so it never joins
// the prompt; it lets a later compare tell what Rubato changed from what the person changed.
// The companion and tools pieces are Rubato's work rules and are never copied: they keep following
// updates. A personal file without a base was not seeded (an older home), so its base is unknown.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** The session entry that marks a conversation as the companion (pi-server session-files create). */
export const COMPANION_ENTRY = 'rubato.companion';
/** The role the engine gives the companion's runtime (rubato-pi role-contract). */
export const COMPANION_ROLE = 'companion';
export const COMPANION_TITLE = 'Segno';

export const PIECES = Object.freeze([
  Object.freeze({ id: 'preamble', editable: true }),
  Object.freeze({ id: 'soul', editable: true }),
  Object.freeze({ id: 'identity', editable: true }),
  Object.freeze({ id: 'user', editable: true }),
  Object.freeze({ id: 'companion', editable: true }),
  Object.freeze({ id: 'tools', editable: false }),
]);
/** The pieces a home starts with as the person's own copy: who Segno is, and who they are. */
export const SEEDED_PIECES = Object.freeze(['preamble', 'soul', 'identity', 'user']);
const PIECE_IDS = new Set(PIECES.map((piece) => piece.id));
/** A personal piece larger than this is refused: it rides on every request. */
export const PIECE_LIMIT = 64 * 1024;

// Anthropic's prompt cache lives an hour, so a beat at an hour or more lands after it expired; a
// stored interval outside these (an older 60, 120 or 240) reads as the default.
export const HEARTBEAT_MINUTES = Object.freeze([15, 30, 45]);
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  heartbeat: Object.freeze({ enabled: true, everyMinutes: 30 }),
  dailyReport: Object.freeze({ enabled: true, time: '09:00' }),
});
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function companionHome(env = process.env) {
  if (env.RUBATO_COMPANION_HOME) return path.resolve(env.RUBATO_COMPANION_HOME);
  return path.join(env.HOME || homedir(), '.rubato', 'companion');
}

export function companionPaths(env = process.env) {
  const home = companionHome(env);
  return { home, settings: path.join(home, 'settings.json'), state: path.join(home, 'state.json'),
    following: path.join(home, 'following.json'), finished: path.join(home, 'finished.json'),
    panel: path.join(home, 'panel.json'), art: path.join(home, 'art'), prompt: path.join(home, 'prompt') };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; if (error instanceof SyntaxError) return undefined; throw error; }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Settings as stored, with every missing or malformed field at its default. */
export function normalizeSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  const heartbeat = input.heartbeat && typeof input.heartbeat === 'object' ? input.heartbeat : {};
  const daily = input.dailyReport && typeof input.dailyReport === 'object' ? input.dailyReport : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
    heartbeat: {
      enabled: typeof heartbeat.enabled === 'boolean' ? heartbeat.enabled : DEFAULT_SETTINGS.heartbeat.enabled,
      everyMinutes: HEARTBEAT_MINUTES.includes(heartbeat.everyMinutes) ? heartbeat.everyMinutes : DEFAULT_SETTINGS.heartbeat.everyMinutes,
    },
    dailyReport: {
      enabled: typeof daily.enabled === 'boolean' ? daily.enabled : DEFAULT_SETTINGS.dailyReport.enabled,
      time: typeof daily.time === 'string' && TIME.test(daily.time) ? daily.time : DEFAULT_SETTINGS.dailyReport.time,
    },
  };
}

export function readSettings(env = process.env) {
  return normalizeSettings(readJson(companionPaths(env).settings));
}

/** Applies `patch` over the stored settings; a field outside the schema is refused. */
export function writeSettings(patch, env = process.env) {
  if (!patch || typeof patch !== 'object') throw new TypeError('settings patch must be an object');
  const current = readSettings(env);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be true or false');
  const heartbeat = patch.heartbeat;
  if (heartbeat !== undefined) {
    if (!heartbeat || typeof heartbeat !== 'object') throw new TypeError('heartbeat must be an object');
    if (heartbeat.enabled !== undefined && typeof heartbeat.enabled !== 'boolean') throw new TypeError('heartbeat.enabled must be true or false');
    if (heartbeat.everyMinutes !== undefined && !HEARTBEAT_MINUTES.includes(heartbeat.everyMinutes))
      throw new TypeError(`heartbeat.everyMinutes must be one of ${HEARTBEAT_MINUTES.join(', ')}`);
  }
  const daily = patch.dailyReport;
  if (daily !== undefined) {
    if (!daily || typeof daily !== 'object') throw new TypeError('dailyReport must be an object');
    if (daily.enabled !== undefined && typeof daily.enabled !== 'boolean') throw new TypeError('dailyReport.enabled must be true or false');
    if (daily.time !== undefined && !(typeof daily.time === 'string' && TIME.test(daily.time))) throw new TypeError('dailyReport.time must be HH:MM');
  }
  const next = normalizeSettings({ ...current, ...patch, heartbeat: { ...current.heartbeat, ...heartbeat },
    dailyReport: { ...current.dailyReport, ...daily } });
  writeJson(companionPaths(env).settings, next);
  return next;
}

/** `dailyReportOn` is the local date (YYYY-MM-DD) the last daily report went out; `heartbeat` the last tick. */
export function readState(env = process.env) {
  const state = readJson(companionPaths(env).state);
  return {
    ...(typeof state?.sessionId === 'string' && state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(typeof state?.dailyReportOn === 'string' ? { dailyReportOn: state.dailyReportOn } : {}),
    ...(typeof state?.sleptOn === 'string' ? { sleptOn: state.sleptOn } : {}),
    // The last heartbeat tick and when it went (keeper.mjs, Roo's heartbeat.json tickCount).
    ...(state?.heartbeat && Number.isFinite(state.heartbeat.at) ? { heartbeat: { tick: state.heartbeat.tick, at: state.heartbeat.at } } : {}),
  };
}

/** Merges `patch` over the stored state. */
export function writeState(patch, env = process.env) {
  writeJson(companionPaths(env).state, { ...readState(env), ...patch });
}

/**
 * The conversations the engine follows for the companion until their handed work ends
 * (pi-server companion-follow.mjs), kept across engine restarts.
 */
export function followingStore(env = process.env) {
  const file = companionPaths(env).following;
  return {
    load: () => { const value = readJson(file); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; },
    save: (records) => writeJson(file, records),
    /** A followed conversation's handed work ended and the companion was told. */
    finished: (entry) => writeFinished(entry, env),
  };
}

/** How many recently finished handoffs the companion's space keeps, and for how long. */
export const FINISHED_LIMITS = Object.freeze({ count: 20, ageMs: 24 * 60 * 60_000 });

/** Recently finished handoffs, newest first. */
export function readFinished(env = process.env, { now = Date.now() } = {}) {
  const value = readJson(companionPaths(env).finished);
  return (Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry?.sessionId === 'string' && Number.isFinite(entry.at) && now - entry.at <= FINISHED_LIMITS.ageMs)
    .sort((a, b) => b.at - a.at).slice(0, FINISHED_LIMITS.count);
}

function writeFinished(entry, env) {
  const at = Number.isFinite(entry?.at) ? entry.at : Date.now();
  const rest = readFinished(env, { now: at }).filter((item) => item.sessionId !== entry.sessionId);
  writeJson(companionPaths(env).finished, [{ ...entry, at }, ...rest].slice(0, FINISHED_LIMITS.count));
}

const LEAD_BUSY = new Set(['starting', 'running', 'waiting']);

/**
 * What the companion's space shows beside its chat (the app's task panel): the conversations it
 * follows, each running or waiting on the user, and the ones that recently finished. `rows` is the
 * engine's session list; `following` the follower's records.
 */
export function composePanel({ following = {}, finished = [], rows = [] }) {
  const byId = new Map(rows.map((row) => [row.sessionId, row]));
  const describe = (id) => { const row = byId.get(id); return row ? { title: row.title ?? null, cwd: row.cwd ?? null } : {}; };
  const leads = Object.entries(following).map(([sessionId, record]) => {
    const row = byId.get(sessionId);
    const asked = record?.asked === true || row?.status === 'waiting';
    return { sessionId, ...describe(sessionId), state: asked ? 'asked' : LEAD_BUSY.has(row?.status) ? 'running' : 'queued',
      since: Number.isFinite(record?.since) ? record.since : null };
  }).sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  const followed = new Set(Object.keys(following));
  const done = finished.filter((entry) => !followed.has(entry.sessionId))
    .map((entry) => ({ sessionId: entry.sessionId, title: byId.get(entry.sessionId)?.title ?? entry.title ?? null,
      cwd: byId.get(entry.sessionId)?.cwd ?? entry.cwd ?? null, outcome: entry.outcome, at: entry.at }));
  return { leads, finished: done };
}

/** Segno's expressions in its space: resting, a lead it follows is running, something waits for the
 * person, and the quiet hours of the night. */
export const STAGE_STATES = Object.freeze(['idle', 'working', 'waiting', 'night']);

/**
 * The art Segno's space shows for `state`, swappable per file: the person's own
 * `art/stage-<state>.webp|png` in the companion's folder, else their single `art/stage.webp|png` for
 * every state, else the default that ships here (art/stage-<state>.webp).
 */
export function stageArtFile(env = process.env, state = 'idle') {
  if (!STAGE_STATES.includes(state)) throw new TypeError(`Unknown stage state: ${state}`);
  const own = companionPaths(env).art;
  for (const name of [`stage-${state}.webp`, `stage-${state}.png`, 'stage.webp', 'stage.png']) {
    if (existsSync(path.join(own, name))) return path.join(own, name);
  }
  return path.join(import.meta.dirname, 'art', `stage-${state}.webp`);
}

export function readPanel(env = process.env) {
  const value = readJson(companionPaths(env).panel);
  return value && Array.isArray(value.leads) && Array.isArray(value.finished) ? value : { leads: [], finished: [] };
}

/** Writes the panel when it changed; returns whether it did. */
export function writePanel(panel, env = process.env) {
  const current = readJson(companionPaths(env).panel);
  const { updatedAt: _ignored, ...before } = current ?? {};
  if (JSON.stringify(before) === JSON.stringify(panel)) return false;
  writeJson(companionPaths(env).panel, { ...panel, updatedAt: new Date().toISOString() });
  return true;
}

function pieceOf(id) {
  if (!PIECE_IDS.has(id)) throw new TypeError(`Unknown prompt piece: ${id}`);
  return PIECES.find((piece) => piece.id === id);
}

export const defaultPiecePath = (defaultsDir, id) => path.join(defaultsDir, `${pieceOf(id).id}.pi.md`);
export const personalPiecePath = (env, id) => path.join(companionPaths(env).prompt, `${pieceOf(id).id}.md`);
/** Where the default text a personal copy was seeded from is kept; never read by the composer. */
export const basePiecePath = (env, id) => path.join(companionPaths(env).prompt, '.base', `${pieceOf(id).id}.md`);
/** The settings page's "have Segno look at it" request; the keeper reads it and wakes Segno. */
const reviewRequestPath = (env) => path.join(companionPaths(env).home, 'persona-review.json');

/** Writes text as a new file, refusing to replace one already there. */
function writeTextNew(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    // `wx` is the never-overwrite rule itself, so two setups racing still leave one file.
    writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Gives a home the person's own copy of who Segno is: each seeded piece is copied from the product
 * default into prompt/<piece>.md, and the default it was copied from into prompt/.base/<piece>.md.
 *
 * - A file already at either place is never overwritten: the person's version is the answer, and a
 *   base already recorded describes the copy the person holds.
 * - A copy the person deleted (or one that was never seeded) comes back on the next setup; a home
 *   set up before this ran gets seeded at its next engine start.
 * - The companion and tools pieces are not copied: they are Rubato's work rules and keep following
 *   updates.
 *
 * Returns which pieces were copied and which were left alone.
 */
export function seedPromptPieces({ defaultsDir, env = process.env } = {}) {
  if (!defaultsDir) throw new TypeError('seeding needs the folder the default pieces live in');
  const seeded = [];
  const kept = [];
  for (const id of SEEDED_PIECES) {
    if (existsSync(personalPiecePath(env, id))) { kept.push(id); continue; }
    let text;
    try { text = readFileSync(defaultPiecePath(defaultsDir, id), 'utf8').trim(); }
    catch (error) { if (error?.code === 'ENOENT') { kept.push(id); continue; } throw error; }
    if (!text) { kept.push(id); continue; }
    if (!writeTextNew(personalPiecePath(env, id), text + '\n')) { kept.push(id); continue; }
    // The base follows the copy that was just made, so it always names the default this version
    // started from even when an older base was left behind by a deleted copy.
    mkdirSync(path.dirname(basePiecePath(env, id)), { recursive: true, mode: 0o700 });
    writeFileSync(basePiecePath(env, id), text + '\n', { mode: 0o600 });
    seeded.push(id);
  }
  return { seeded, kept };
}

/**
 * The product defaults that moved away from the base a person's copy was seeded from. A copy with no
 * base (an older home) is not reviewed automatically: there is nothing to compare it to, so the
 * person asks for that review from the Settings page.
 */
export function pendingDefaultChanges({ defaultsDir, env = process.env } = {}) {
  if (!defaultsDir) throw new TypeError('a review needs the folder the default pieces live in');
  const pending = [];
  for (const id of SEEDED_PIECES) {
    const base = readOptional(basePiecePath(env, id), (file) => readFileSync(file, 'utf8'));
    if (base === undefined) continue;
    const defaultText = readFileSync(defaultPiecePath(defaultsDir, id), 'utf8').trim();
    if (defaultText === base) continue;
    pending.push({ id, baseText: base, defaultText, defaultPath: defaultPiecePath(defaultsDir, id) });
  }
  return pending;
}

/**
 * The base moves to the default Segno was just told about, whether or not the person takes anything:
 * one default change wakes Segno once, and the next update compares from this default.
 */
export function moveBaseToDefault(id, { defaultsDir, env = process.env } = {}) {
  const defaultText = readFileSync(defaultPiecePath(defaultsDir, pieceOf(id).id), 'utf8').trim();
  mkdirSync(path.dirname(basePiecePath(env, id)), { recursive: true, mode: 0o700 });
  writeFileSync(basePiecePath(env, id), defaultText + '\n', { mode: 0o600 });
  return { id: pieceOf(id).id, baseText: defaultText };
}

/** The page's on-demand review: a request file the keeper picks up on its next pass. */
export function requestPersonaReview(env = process.env, { at = Date.now() } = {}) {
  writeJson(reviewRequestPath(env), { at: new Date(at).toISOString() });
}

/** The waiting request's time, or undefined when nobody asked. */
export function readPersonaReviewRequest(env = process.env) {
  const value = readJson(reviewRequestPath(env));
  return typeof value?.at === 'string' && value.at ? value.at : undefined;
}

export function clearPersonaReviewRequest(env = process.env) {
  rmSync(reviewRequestPath(env), { force: true });
}

/**
 * Every piece for the settings page: its default text, the person's version if any, whether it can
 * have one, and for a copy that exists, the default it was seeded from (`baseText`) or
 * `baseUnknown` when the file predates seeding.
 */
export function readPieces({ defaultsDir, env = process.env, readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  return PIECES.map(({ id, editable }) => {
    const defaultText = readFile(defaultPiecePath(defaultsDir, id)).trim();
    const personal = editable ? readOptional(personalPiecePath(env, id), readFile) : undefined;
    if (personal === undefined) return { id, editable, defaultText };
    const base = readOptional(basePiecePath(env, id), readFile);
    const changed = base !== undefined && base !== defaultText;
    return { id, editable, defaultText, personalText: personal,
      ...(base === undefined ? { baseUnknown: true } : { baseText: base }),
      ...(changed ? { defaultChanged: true } : {}) };
  });
}

function readOptional(file, readFile) {
  try { return readFile(file).trim(); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

/** Saves the person's version of one piece; an empty text or the default itself removes it. */
export function writePiece(id, text, { defaultsDir, env = process.env } = {}) {
  const piece = pieceOf(id);
  if (!piece.editable) throw new TypeError(`The ${id} piece follows the product and has no personal version`);
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length > PIECE_LIMIT) throw new TypeError(`A piece holds at most ${PIECE_LIMIT} characters`);
  const file = personalPiecePath(env, id);
  const trimmed = text.trim();
  const defaultText = defaultsDir && existsSync(defaultPiecePath(defaultsDir, id))
    ? readFileSync(defaultPiecePath(defaultsDir, id), 'utf8').trim() : undefined;
  if (!trimmed || trimmed === defaultText) {
    rmSync(file, { force: true });
    rmSync(basePiecePath(env, id), { force: true });
    return { personal: false };
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, trimmed + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return { personal: true };
}

/** The companion's whole role prompt: each piece, the person's version first, in order. */
export function composeCompanionPrompt({ defaultsDir, env = process.env, readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  return readPieces({ defaultsDir, env, readFile })
    .map((piece) => piece.personalText ?? piece.defaultText)
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** Whether a session's entries carry the companion marker. */
export function isCompanionEntries(entries) {
  return Array.isArray(entries) && entries.some((entry) => entry?.type === 'custom' && entry.customType === COMPANION_ENTRY);
}
