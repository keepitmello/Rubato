// The companion (Segno): one always-on conversation above the leads. This module is the one
// place that knows where its files live and what they hold; the engine control tower, the role prompt
// and the app's Companion settings page all read and write through it.
//
//   ~/.rubato/companion/                 the companion's home and its conversation's folder
//     settings.json                      what the person chose in Settings › Companion
//     state.json                         which conversation is the companion (written by the control tower)
//     prompt/<piece>.md                  the person's version of one prompt piece
//     prompt/.base/<piece>.md            the product default that version was copied from
//     memory/MEMORY.md                   the resident memory piece (Roo MEMORY.md), kept by the dream
//
// The order is Roo's build.sh: preamble, soul, identity, user, companion, tools, then the resident
// memory in the last recency slot, and the closing piece (coda) at the very end of the whole system
// prompt, after whatever Rubato appends (system-prompt.mjs codaLast): "시작도 SOUL, 끝도 SOUL".
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
import { SCHEDULE_SOURCE_LIMIT, normalizeSource } from './schedule.mjs';
import { DEFAULT_COMPANION_ID, registryPath, usesProductTexts } from './registry.mjs';

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
  Object.freeze({ id: 'memory', editable: true }),
  Object.freeze({ id: 'coda', editable: true }),
]);
/** The pieces a home starts with as the person's own copy: who Segno is, and who they are. */
export const SEEDED_PIECES = Object.freeze(['preamble', 'soul', 'identity', 'user']);
const PIECE_IDS = new Set(PIECES.map((piece) => piece.id));
/**
 * A companion the app made starts from these instead of Segno's: the same temperament (a young
 * wolf, a puppy with the user), but nameless. Their slots (`{{name}}` …) are filled from the
 * companion's profile when the prompt is composed (renderProfile), so a name never has to be
 * written into a person's own text. The other pieces are Rubato's own and shared with Segno.
 */
export const NEW_COMPANION_DEFAULTS = 'new';
const NEW_COMPANION_PIECES = new Set(SEEDED_PIECES);
/** A personal piece larger than this is refused: it rides on every request. */
export const PIECE_LIMIT = 64 * 1024;

// Anthropic's prompt cache lives an hour, so a beat at an hour or more lands after it expired; a
// stored interval outside these (an older 60, 120 or 240) reads as the default.
export const HEARTBEAT_MINUTES = Object.freeze([15, 30, 45]);
/**
 * `greetings` are Roo's night (00:07) and morning (09:07) greetings; the morning one carries the
 * daily report (user item 4c0b0f00). `schedule.sources` are the calendars (ICS address or .ics file)
 * and schedule files the heartbeat reads for its nudges (schedule.mjs, which documents the format);
 * Segno sets them when the user tells it. None by default. `heartbeat.quietDuringWish` is whether a
 * pending wake wish silences plain and reflect ticks (Segno's rest, user 2026-10-20); off, they keep
 * coming and a reflect goes as a plain tick until the wish, as Roo's old tick did. `heartbeat.reflectNote`
 * is the companion's own text under each reflect tick, after a blank line as a greeting's body goes.
 * `location.source` is a JSON file with the user's last known place (`{ current, updatedAt }`, at the
 * top or under `location`, as Roo's OwnTracks state/user.json keeps it); each tick carries it as a
 * LOCATION line (control-tower.mjs). Empty by default: no line.
 */
/** `heartbeat.reflectNote` rides on every reflect tick; longer than this is refused. */
export const REFLECT_NOTE_LIMIT = 2000;
/**
 * `call.effort` is the companion conversation's effort while a voice call is open (call bridge
 * pi-runtime companion-home/call.mjs); `conversation` leaves the conversation's own level alone.
 * Medium by default: a call waits on each turn, and high made thinking turns 1.5–2 s slower (user 2026-11-14).
 */
export const CALL_EFFORTS = Object.freeze(['conversation', 'low', 'medium', 'high']);
/**
 * `dream.docs` is the dream's second job, document upkeep (dream/docs.mjs, dream/docs.md): how often
 * it comes (`cadence`) and the folders or files it tends (`roots`). Each root is `{ path, mode }`:
 * `edit` changes it in place and is only for a place inside the companion's home; `branch` works in
 * a git worktree of the root's repository and leaves its commits on a `dream/docs-YYYYMMDD` branch for
 * review; `report` only reads. No roots (the default) means the job never runs.
 */
export const DOCS_CADENCES = Object.freeze(['off', 'daily', 'weekly', 'monthly']);
export const DOCS_ROOT_MODES = Object.freeze(['edit', 'branch', 'report']);
export const DOCS_ROOT_LIMIT = 20;
/**
 * `dream.models` is this companion's own dream ladder: the models its memory dream and its docs job
 * run on, in fallback order, each `{ model: "<provider>/<id>", reasoning? }` as in the global
 * `memory.dream.models`. Empty (the default) means the global ladder, then dream.mjs DREAM_MODELS
 * (dream/service.mjs resolveModels).
 */
export const DREAM_MODEL_LIMIT = 8;
/** The reasoning levels a rung may name: config-core REASONING_LEVELS (a test keeps the two the same). */
export const DREAM_REASONING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const DREAM_MODEL_ID = /^[A-Za-z0-9][\w.-]*\/[^\s]{1,200}$/;

/** One rung as stored, `{ model, reasoning? }`, from a string or an object; undefined when it is not one. */
function dreamRung(entry) {
  const value = typeof entry === 'string' ? { model: entry } : entry;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => key !== 'model' && key !== 'reasoning')) return undefined;
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!DREAM_MODEL_ID.test(model)) return undefined;
  if (value.reasoning !== undefined && !DREAM_REASONING_LEVELS.includes(value.reasoning)) return undefined;
  return value.reasoning === undefined ? { model } : { model, reasoning: value.reasoning };
}

function normalizeDreamModels(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(dreamRung)
    .filter((rung) => rung && !seen.has(rung.model) && seen.add(rung.model)).slice(0, DREAM_MODEL_LIMIT);
}
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  heartbeat: Object.freeze({ enabled: true, everyMinutes: 30, quietDuringWish: true, reflectNote: '' }),
  greetings: Object.freeze({ enabled: true }),
  schedule: Object.freeze({ sources: Object.freeze([]) }),
  location: Object.freeze({ source: '' }),
  call: Object.freeze({ effort: 'medium' }),
  dream: Object.freeze({ models: Object.freeze([]), docs: Object.freeze({ cadence: 'weekly', roots: Object.freeze([]) }) }),
});
/** A location source longer than this is not a path. */
const LOCATION_SOURCE_LIMIT = 2048;

/** A docs root's path with `~/` read against HOME, resolved; undefined when it is not a usable path. */
export function docsRootPath(value, env = process.env) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > LOCATION_SOURCE_LIMIT || /[\u0000-\u001f]/.test(text)) return undefined;
  if (text === '~' || text.startsWith('~/')) return path.join(env.HOME || homedir(), text.slice(1));
  return path.isAbsolute(text) ? path.resolve(text) : undefined;
}

const insideOf = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/**
 * Why a docs root cannot be kept, or undefined when it can: the path must be absolute (or `~/…`),
 * `edit` only inside the companion's home (anywhere else a change would have no review), and a
 * place inside the home is never a `branch` (the home keeps its own history).
 */
export function docsRootProblem(root, env = process.env) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return 'each docs root is { path, mode }';
  const full = docsRootPath(root.path, env);
  if (!full) return 'a docs root path is absolute or starts with ~/';
  if (!DOCS_ROOT_MODES.includes(root.mode)) return `a docs root's mode is one of ${DOCS_ROOT_MODES.join(', ')}`;
  const inHome = insideOf(companionHome(env), full);
  if (root.mode === 'edit' && !inHome) return "edit is only for a place inside the companion's home; a repository is a branch root, anything else a report root";
  if (root.mode === 'branch' && inHome) return "the companion's home is an edit or report root, never a branch";
  return undefined;
}

function normalizeDocs(value, env) {
  const input = value && typeof value === 'object' ? value : {};
  const seen = new Set();
  const roots = (Array.isArray(input.roots) ? input.roots : [])
    .filter((root) => !docsRootProblem(root, env))
    .map((root) => ({ path: root.path.trim(), mode: root.mode }))
    .filter((root) => !seen.has(root.path) && seen.add(root.path))
    .slice(0, DOCS_ROOT_LIMIT);
  return { cadence: DOCS_CADENCES.includes(input.cadence) ? input.cadence : DEFAULT_SETTINGS.dream.docs.cadence, roots };
}

export function companionHome(env = process.env) {
  if (env.RUBATO_COMPANION_HOME) return path.resolve(env.RUBATO_COMPANION_HOME);
  return path.join(env.HOME || homedir(), '.rubato', 'companion');
}

export function companionPaths(env = process.env) {
  const home = companionHome(env);
  return { home, settings: path.join(home, 'settings.json'), state: path.join(home, 'state.json'),
    following: path.join(home, 'following.json'), finished: path.join(home, 'finished.json'),
    panel: path.join(home, 'panel.json'), dismissed: path.join(home, 'dismissed.json'), art: path.join(home, 'art'), prompt: path.join(home, 'prompt'),
    // What the app keeps about a companion lives outside its home (appDataDir), so a registered
    // existing home's records and history stay exactly as they were.
    profile: path.join(appDataDir(env), 'profile.json'), proposals: path.join(appDataDir(env), 'proposals') };
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
export function normalizeSettings(value, env = process.env) {
  const input = value && typeof value === 'object' ? value : {};
  const heartbeat = input.heartbeat && typeof input.heartbeat === 'object' ? input.heartbeat : {};
  // A home from before the greetings kept `dailyReport`; its switch is the greetings' switch now.
  const greetings = input.greetings && typeof input.greetings === 'object' ? input.greetings
    : input.dailyReport && typeof input.dailyReport === 'object' ? input.dailyReport : {};
  const call = input.call && typeof input.call === 'object' ? input.call : {};
  const location = input.location && typeof input.location === 'object' ? input.location : {};
  // An older home kept one schedule path as `career.schedule`; it reads as one markdown source.
  const listed = Array.isArray(input.schedule?.sources) ? input.schedule.sources
    : typeof input.career?.schedule === 'string' && input.career.schedule.trim() ? [{ kind: 'markdown', location: input.career.schedule }] : [];
  const seen = new Set();
  const sources = listed.map(normalizeSource).filter((source) => source && !seen.has(source.location) && seen.add(source.location))
    .slice(0, SCHEDULE_SOURCE_LIMIT);
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
    heartbeat: {
      enabled: typeof heartbeat.enabled === 'boolean' ? heartbeat.enabled : DEFAULT_SETTINGS.heartbeat.enabled,
      everyMinutes: HEARTBEAT_MINUTES.includes(heartbeat.everyMinutes) ? heartbeat.everyMinutes : DEFAULT_SETTINGS.heartbeat.everyMinutes,
      quietDuringWish: typeof heartbeat.quietDuringWish === 'boolean' ? heartbeat.quietDuringWish : DEFAULT_SETTINGS.heartbeat.quietDuringWish,
      reflectNote: typeof heartbeat.reflectNote === 'string' ? heartbeat.reflectNote.trim().slice(0, REFLECT_NOTE_LIMIT) : DEFAULT_SETTINGS.heartbeat.reflectNote,
    },
    greetings: { enabled: typeof greetings.enabled === 'boolean' ? greetings.enabled : DEFAULT_SETTINGS.greetings.enabled },
    schedule: { sources },
    location: { source: typeof location.source === 'string' && location.source.trim().length <= LOCATION_SOURCE_LIMIT
      ? location.source.trim() : DEFAULT_SETTINGS.location.source },
    call: { effort: CALL_EFFORTS.includes(call.effort) ? call.effort : DEFAULT_SETTINGS.call.effort },
    dream: { models: normalizeDreamModels(input.dream?.models), docs: normalizeDocs(input.dream?.docs, env) },
  };
}

export function readSettings(env = process.env) {
  return normalizeSettings(readJson(companionPaths(env).settings), env);
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
    if (heartbeat.quietDuringWish !== undefined && typeof heartbeat.quietDuringWish !== 'boolean') throw new TypeError('heartbeat.quietDuringWish must be true or false');
    if (heartbeat.reflectNote !== undefined && typeof heartbeat.reflectNote !== 'string') throw new TypeError('heartbeat.reflectNote must be text');
    if (typeof heartbeat.reflectNote === 'string' && heartbeat.reflectNote.trim().length > REFLECT_NOTE_LIMIT)
      throw new TypeError(`heartbeat.reflectNote holds at most ${REFLECT_NOTE_LIMIT} characters`);
  }
  const greetings = patch.greetings;
  if (greetings !== undefined) {
    if (!greetings || typeof greetings !== 'object') throw new TypeError('greetings must be an object');
    if (greetings.enabled !== undefined && typeof greetings.enabled !== 'boolean') throw new TypeError('greetings.enabled must be true or false');
  }
  const call = patch.call;
  if (call !== undefined) {
    if (!call || typeof call !== 'object') throw new TypeError('call must be an object');
    if (call.effort !== undefined && !CALL_EFFORTS.includes(call.effort))
      throw new TypeError(`call.effort must be one of ${CALL_EFFORTS.join(', ')}`);
  }
  const location = patch.location;
  if (location !== undefined) {
    if (!location || typeof location !== 'object') throw new TypeError('location must be an object');
    if (location.source !== undefined && (typeof location.source !== 'string' || location.source.trim().length > LOCATION_SOURCE_LIMIT))
      throw new TypeError('location.source is the path of a location file, or empty for none');
  }
  const schedule = patch.schedule;
  if (schedule !== undefined) {
    if (!schedule || typeof schedule !== 'object') throw new TypeError('schedule must be an object');
    if (schedule.sources !== undefined) {
      if (!Array.isArray(schedule.sources)) throw new TypeError('schedule.sources must be a list');
      if (schedule.sources.length > SCHEDULE_SOURCE_LIMIT) throw new TypeError(`schedule.sources holds at most ${SCHEDULE_SOURCE_LIMIT} sources`);
      for (const source of schedule.sources) {
        if (!normalizeSource(source)) throw new TypeError('each schedule source needs a location: an ICS address, an .ics file or a schedule file');
        if (source?.kind !== undefined && source.kind !== 'ics' && source.kind !== 'markdown') throw new TypeError("a schedule source's kind is 'ics' or 'markdown'");
      }
    }
  }
  const dream = patch.dream;
  if (dream !== undefined) {
    if (!dream || typeof dream !== 'object' || Array.isArray(dream)) throw new TypeError('dream must be an object');
    if (dream.models !== undefined) {
      if (!Array.isArray(dream.models)) throw new TypeError('dream.models must be a list');
      if (dream.models.length > DREAM_MODEL_LIMIT) throw new TypeError(`dream.models holds at most ${DREAM_MODEL_LIMIT} models`);
      const seen = new Set();
      for (const entry of dream.models) {
        const rung = dreamRung(entry);
        if (!rung) throw new TypeError(`each dream model is "<provider>/<id>" or { model, reasoning } with reasoning one of ${DREAM_REASONING_LEVELS.join(', ')}`);
        if (seen.has(rung.model)) throw new TypeError(`dream.models names ${rung.model} twice`);
        seen.add(rung.model);
      }
    }
    const docs = dream.docs;
    if (docs !== undefined) {
      if (!docs || typeof docs !== 'object' || Array.isArray(docs)) throw new TypeError('dream.docs must be an object');
      if (docs.cadence !== undefined && !DOCS_CADENCES.includes(docs.cadence))
        throw new TypeError(`dream.docs.cadence must be one of ${DOCS_CADENCES.join(', ')}`);
      if (docs.roots !== undefined) {
        if (!Array.isArray(docs.roots)) throw new TypeError('dream.docs.roots must be a list');
        if (docs.roots.length > DOCS_ROOT_LIMIT) throw new TypeError(`dream.docs.roots holds at most ${DOCS_ROOT_LIMIT} roots`);
        const seen = new Set();
        for (const root of docs.roots) {
          const problem = docsRootProblem(root, env);
          if (problem) throw new TypeError(problem);
          // One place, one mode: a second entry for the same place would be dropped on reading.
          const full = docsRootPath(root.path, env);
          if (seen.has(full)) throw new TypeError(`dream.docs.roots names ${root.path.trim()} twice; keep one entry with one mode`);
          seen.add(full);
        }
      }
    }
  }
  const { dailyReport: _old, career: _career, ...rest } = patch;
  const next = normalizeSettings({ ...current, ...rest, heartbeat: { ...current.heartbeat, ...heartbeat },
    greetings: { ...current.greetings, ...greetings }, schedule: { ...current.schedule, ...schedule },
    location: { ...current.location, ...location }, call: { ...current.call, ...call },
    dream: { ...current.dream, ...dream, docs: { ...current.dream.docs, ...dream?.docs } } }, env);
  writeJson(companionPaths(env).settings, next);
  return next;
}

/**
 * What the control tower keeps: `greeted` is the local date (YYYY-MM-DD) each greeting last went out (Roo's
 * state/cron-last-run.json), `heartbeat` the last tick, `woke` the last boundary Segno was woken for
 * and what is still owed (a seed, or the recall that follows a fresh one), `sleptIn` the window
 * (that boundary, null before the first) the companion was last put to sleep in,
 * `inboxWake` how far the listener's wake lines were read.
 */
export function readState(env = process.env) {
  const state = readJson(companionPaths(env).state);
  const greeted = state?.greeted && typeof state.greeted === 'object' ? Object.fromEntries(['night', 'morning']
    .filter((slot) => typeof state.greeted[slot] === 'string').map((slot) => [slot, state.greeted[slot]])) : undefined;
  const woke = state?.woke && typeof state.woke === 'object' && (typeof state.woke.boundary === 'string' || state.woke.boundary === null)
    ? { boundary: state.woke.boundary,
      ...(['fresh', 'compact', 'recall'].includes(state.woke.pending) ? { pending: state.woke.pending } : {}),
      ...(Number.isFinite(state.woke.at) ? { at: state.woke.at } : {}) } : undefined;
  return {
    ...(typeof state?.sessionId === 'string' && state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(greeted ? { greeted } : {}),
    ...(typeof state?.sleptIn === 'string' || state?.sleptIn === null ? { sleptIn: state.sleptIn } : {}),
    // The last heartbeat tick and when it went (control-tower.mjs, Roo's heartbeat.json tickCount).
    ...(state?.heartbeat && Number.isFinite(state.heartbeat.at) ? { heartbeat: { tick: state.heartbeat.tick, at: state.heartbeat.at } } : {}),
    ...(woke ? { woke } : {}),
    // The runtime the control tower last found the conversation loaded in; a new one means it was loaded again.
    ...(typeof state?.runtimeId === 'string' && state.runtimeId ? { runtimeId: state.runtimeId } : {}),
    // How far the control tower has read the listener's wake lines (inbox.mjs inboxWakePath), in bytes.
    ...(Number.isInteger(state?.inboxWake?.offset) && state.inboxWake.offset >= 0 ? { inboxWake: { offset: state.inboxWake.offset } } : {}),
    // The last docs report the control tower put under a tick (dream/docs.mjs docsReportLine), by run id.
    ...(typeof state?.docsReportSeen === 'string' && state.docsReportSeen ? { docsReportSeen: state.docsReportSeen } : {}),
  };
}

/** Merges `patch` over the stored state. */
export function writeState(patch, env = process.env) {
  writeJson(companionPaths(env).state, { ...readState(env), ...patch });
}

/**
 * The conversations the engine follows for the companion while their handed work can still go on
 * (pi-server companion-follow.mjs), kept across engine restarts.
 */
export function followingStore(env = process.env) {
  const file = companionPaths(env).following;
  return {
    load: () => { const value = readJson(file); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; },
    save: (records) => writeJson(file, records),
    /** A followed conversation's handed work ended and the companion was told. */
    finished: (entry) => writeFinished(entry, env),
    /** While the companion is turned off, its notices wait: a lead's end does not wake it. */
    paused: () => !readSettings(env).enabled,
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

/** One ending of handed work: the same conversation can finish again later, and that ending shows anew. */
const endingKey = (entry) => `${entry.sessionId}@${entry.at}`;

/** The endings the person closed in the companion's space; kept as long as the endings themselves. */
export function readDismissed(env = process.env, { now = Date.now() } = {}) {
  const value = readJson(companionPaths(env).dismissed);
  return (Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry?.sessionId === 'string' && Number.isFinite(entry.at) && now - entry.at <= FINISHED_LIMITS.ageMs);
}

/**
 * Closes endings in the companion's space: they leave the panel and do not come back. Only the
 * panel forgets them; the conversations and the companion's own record of the ending stay.
 */
export function dismissFinished(entries, env = process.env, { now = Date.now() } = {}) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.sessionId !== 'string' || !entry.sessionId || !Number.isFinite(entry?.at)))
    throw new TypeError('Each ending to close needs its sessionId and at.');
  const kept = readDismissed(env, { now });
  const known = new Set(kept.map(endingKey));
  const added = entries.filter((entry) => !known.has(endingKey(entry))).map(({ sessionId, at }) => ({ sessionId, at }));
  if (added.length > 0) writeJson(companionPaths(env).dismissed, [...kept, ...added]);
}

/** `finished` without the endings the person closed. */
export function withoutDismissed(finished, env = process.env) {
  const closed = new Set(readDismissed(env).map(endingKey));
  return closed.size === 0 ? finished : finished.filter((entry) => !closed.has(endingKey(entry)));
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
  const leads = Object.entries(following).flatMap(([sessionId, record]) => {
    const row = byId.get(sessionId);
    const asked = record?.asked === true || row?.status === 'waiting';
    const busy = LEAD_BUSY.has(row?.status);
    // A lead whose handed turn ended is still followed for what its background work wakes; it is
    // listed as working again only while such a turn runs, and stays among the finished meanwhile.
    if (record?.ended === true && !asked && !busy) return [];
    return [{ sessionId, ...describe(sessionId), state: asked ? 'asked' : busy ? 'running' : 'queued',
      since: Number.isFinite(record?.since) ? record.since : null }];
  }).sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  const followed = new Set(leads.map((lead) => lead.sessionId));
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
  if (env.RUBATO_COMPANION_ID && env.RUBATO_COMPANION_ID !== DEFAULT_COMPANION_ID)
    throw Object.assign(new Error('No personal companion art is configured'), { code: 'ENOENT' });
  return path.join(import.meta.dirname, 'art', `stage-${state}.webp`);
}

/**
 * What the app keeps about one companion: its picture, its profile (profile.json) and the changes it
 * proposed (proposals/). Beside the registry, one folder per companion id, outside every home, so
 * giving a companion a face or a card never touches its records.
 */
export function appDataDir(env = process.env) {
  return path.join(path.dirname(registryPath(env)), 'companion-app', env.RUBATO_COMPANION_ID || DEFAULT_COMPANION_ID);
}
export const pictureDir = (env = process.env) => appDataDir(env);
export const PICTURE_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });

/** The picture set in the app, if any. */
export function pictureFile(env = process.env, slot = 'avatar') {
  const dir = pictureDir(env);
  for (const ext of Object.values(PICTURE_TYPES)) {
    if (existsSync(path.join(dir, `${slot}.${ext}`))) return path.join(dir, `${slot}.${ext}`);
  }
  return null;
}

/**
 * The companion's face for the lists, the room header and the profile: the picture set in the app,
 * else `art/avatar.{webp,png,jpg}` in its own home, else its idle stage art, else null.
 */
export function avatarFile(env = process.env) {
  const set = pictureFile(env);
  if (set) return set;
  const own = companionPaths(env).art;
  for (const name of ['avatar.webp', 'avatar.png', 'avatar.jpg', 'avatar.jpeg']) {
    if (existsSync(path.join(own, name))) return path.join(own, name);
  }
  try { return stageArtFile(env, 'idle'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
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

/** The product default of one piece: a companion the app made reads the nameless new-companion texts. */
export const defaultPiecePath = (defaultsDir, id, env = {}) => path.join(
  env.RUBATO_COMPANION_MADE_IN_APP === '1' && NEW_COMPANION_PIECES.has(pieceOf(id).id) ? path.join(defaultsDir, NEW_COMPANION_DEFAULTS) : defaultsDir,
  `${pieceOf(id).id}.pi.md`);
/** The resident memory piece lives with Segno's memory, where the dream keeps it, not under prompt/. */
export const memoryPiecePath = (env = process.env) => path.join(companionHome(env),
  JSON.parse(env.RUBATO_COMPANION_LAYOUT || '{}').resident || 'memory/MEMORY.md');
export const personalPiecePath = (env, id) => {
  pieceOf(id);
  const mapped = JSON.parse(env.RUBATO_COMPANION_PROMPT_FILES || '{}')[id];
  return mapped || (id === 'memory' ? memoryPiecePath(env) : path.join(companionPaths(env).prompt, `${id}.md`));
};
/** Where the default text a personal copy was seeded from is kept; never read by the composer. */
export const basePiecePath = (env, id) => path.join(companionPaths(env).prompt, '.base', `${pieceOf(id).id}.md`);
/** The settings page's "have Segno look at it" request; the control tower reads it and wakes Segno. */
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
    try { text = readFileSync(defaultPiecePath(defaultsDir, id, env), 'utf8').trim(); }
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
    const defaultText = readFileSync(defaultPiecePath(defaultsDir, id, env), 'utf8').trim();
    if (defaultText === base) continue;
    pending.push({ id, baseText: base, defaultText, defaultPath: defaultPiecePath(defaultsDir, id, env) });
  }
  return pending;
}

/**
 * The base moves to the default Segno was just told about, whether or not the person takes anything:
 * one default change wakes Segno once, and the next update compares from this default.
 */
export function moveBaseToDefault(id, { defaultsDir, env = process.env } = {}) {
  const defaultText = readFileSync(defaultPiecePath(defaultsDir, pieceOf(id).id, env), 'utf8').trim();
  mkdirSync(path.dirname(basePiecePath(env, id)), { recursive: true, mode: 0o700 });
  writeFileSync(basePiecePath(env, id), defaultText + '\n', { mode: 0o600 });
  return { id: pieceOf(id).id, baseText: defaultText };
}

/** The page's on-demand review: a request file the control tower picks up on its next pass. */
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
    const defaultText = readFile(defaultPiecePath(defaultsDir, id, env)).trim();
    const mapped = JSON.parse(env.RUBATO_COMPANION_PROMPT_FILES || '{}')[id];
    const personal = editable || mapped ? readOptional(personalPiecePath(env, id), readFile) : undefined;
    if (!usesProductTexts(env) && personal === undefined)
      throw new TypeError(`Companion ${env.RUBATO_COMPANION_ID} has no private ${id} piece; refusing another persona's default`);
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
  const defaultText = defaultsDir && existsSync(defaultPiecePath(defaultsDir, id, env))
    ? readFileSync(defaultPiecePath(defaultsDir, id, env), 'utf8').trim() : undefined;
  if (!trimmed || trimmed === defaultText) {
    // One step: the copy is set aside, its base removed, then the copy dropped. A base that cannot be
    // removed puts the copy back, so a failed reset leaves the person's file as it was.
    const aside = existsSync(file) ? `${file}.${randomUUID()}.removing` : undefined;
    if (aside) renameSync(file, aside);
    try { rmSync(basePiecePath(env, id), { force: true }); }
    catch (error) { if (aside) renameSync(aside, file); throw error; }
    if (aside) rmSync(aside, { force: true });
    return { personal: false };
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, trimmed + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return { personal: true };
}

/**
 * Marks the resident memory and the closing piece inside the composed role prompt, so the system
 * prompt can carry both to its very end, after everything Rubato adds behind the role prompt
 * (codaLast): the memory in the last recency slot, then the coda (Roo build.sh).
 */
export const MEMORY_OPEN = '<!-- segno:memory -->';
export const MEMORY_CLOSE = '<!-- /segno:memory -->';
export const CODA_OPEN = '<!-- segno:coda -->';
export const CODA_CLOSE = '<!-- /segno:coda -->';

/** The companion's whole role prompt: each piece, the person's version first, in order; memory and coda marked. */
export function composeCompanionPrompt({ defaultsDir, env = process.env, readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  const profile = readProfile(env);
  const pieces = readPieces({ defaultsDir, env, readFile })
    .map((piece) => ({ id: piece.id, text: renderProfile(piece.personalText ?? piece.defaultText, profile, env) }));
  // While a companion the app made is still being met, its first-meeting text rides after who the user is.
  if (onboardingActive(profile)) {
    const at = pieces.findIndex((piece) => piece.id === 'user') + 1;
    pieces.splice(at, 0, { id: 'onboarding', text: readFile(path.join(defaultsDir, NEW_COMPANION_DEFAULTS, 'onboarding.pi.md')).trim() });
  }
  const marked = { memory: [MEMORY_OPEN, MEMORY_CLOSE], coda: [CODA_OPEN, CODA_CLOSE] };
  return pieces.filter((piece) => piece.text.length > 0)
    .map((piece) => (marked[piece.id] ? `${marked[piece.id][0]}\n${piece.text}\n${marked[piece.id][1]}` : piece.text)).join('\n\n');
}

/** Cuts the block between `open` and `close` out of `prompt`; returns the rest and the block's text. */
function cut(prompt, open, close) {
  const start = prompt.indexOf(open);
  const end = start < 0 ? -1 : prompt.indexOf(close, start);
  if (end < 0) return { rest: prompt, text: undefined };
  return { rest: (prompt.slice(0, start).trimEnd() + '\n\n' + prompt.slice(end + close.length).trimStart()).trim(),
    text: prompt.slice(start + open.length, end).trim() };
}

/**
 * Moves the marked resident memory and coda to the very end of `prompt`: the memory, then a rule
 * and the coda, as Roo's build.sh closes its system prompt — "MEMORY는 마지막 recency 슬롯", and the
 * last tokens in Segno's own voice. A prompt without the marks is returned as it is.
 */
export function codaLast(prompt) {
  if (typeof prompt !== 'string') return prompt;
  const memory = cut(prompt, MEMORY_OPEN, MEMORY_CLOSE);
  const coda = cut(memory.rest, CODA_OPEN, CODA_CLOSE);
  if (memory.text === undefined && coda.text === undefined) return prompt;
  return [coda.rest, memory.text || '', coda.text ? `---\n\n${coda.text}` : ''].filter(Boolean).join('\n\n');
}

/** Whether a session's entries carry the companion marker. */
export function isCompanionEntries(entries) {
  return Array.isArray(entries) && entries.some((entry) => entry?.type === 'custom' && entry.customType === COMPANION_ENTRY);
}

// What a companion is to the person, in plain facts: its name, how it calls them, what they do,
// what they are to each other and the rest the first meeting settles (profile.json in its app folder, appDataDir).
// The app shows these on the profile and as the first meeting's chips; the new-companion pieces
// read them through their slots. `cards` are the two readable summaries the companion keeps of
// itself and of the person ("who it is", "what it knows about me").
//
//   profile.json  { facts: { name?, callsUser?, … }, deferred: [key…],
//                   onboarding?: { startedAt, finishedAt? }, cards?: { who?, me?, updatedAt } }
export const ONBOARDING_ITEMS = Object.freeze(['name', 'callsUser', 'work', 'relationship', 'look', 'speech', 'closeness']);
/** The first meeting settles these four; the rest may wait and be filled while living. */
export const ONBOARDING_CORE = Object.freeze(['name', 'callsUser', 'work', 'relationship']);
export const FACT_LIMIT = 300;
export const CARD_KEYS = Object.freeze({ who: Object.freeze(['line', 'nature', 'speech', 'bond']), me: Object.freeze(['work', 'now', 'talk', 'trust']) });
export const CARD_LIMIT = 400;
const UNSET = '(not chosen yet)';

const textOr = (value, limit) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined);

/** The profile as stored, with anything malformed left out. */
export function readProfile(env = process.env) {
  const value = readJson(companionPaths(env).profile);
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const facts = {};
  for (const key of ONBOARDING_ITEMS) { const text = textOr(input.facts?.[key], FACT_LIMIT); if (text) facts[key] = text; }
  const deferred = Array.isArray(input.deferred) ? ONBOARDING_ITEMS.filter((key) => input.deferred.includes(key) && !facts[key]) : [];
  const onboarding = input.onboarding && typeof input.onboarding === 'object' && typeof input.onboarding.startedAt === 'string'
    ? { startedAt: input.onboarding.startedAt, ...(typeof input.onboarding.finishedAt === 'string' ? { finishedAt: input.onboarding.finishedAt } : {}) }
    : undefined;
  const cards = {};
  for (const [card, keys] of Object.entries(CARD_KEYS)) {
    const rows = keys.flatMap((key) => { const text = textOr(input.cards?.[card]?.[key], CARD_LIMIT); return text ? [[key, text]] : []; });
    if (rows.length) cards[card] = Object.fromEntries(rows);
  }
  if (Object.keys(cards).length && typeof input.cards?.updatedAt === 'string') cards.updatedAt = input.cards.updatedAt;
  return { facts, deferred, ...(onboarding ? { onboarding } : {}), ...(Object.keys(cards).length ? { cards } : {}) };
}

export function writeProfile(profile, env = process.env) {
  writeJson(companionPaths(env).profile, profile);
  return readProfile(env);
}

/** Whether the companion is still in its first meeting. */
export const onboardingActive = (profile) => Boolean(profile?.onboarding && !profile.onboarding.finishedAt);

/**
 * Fills the new-companion pieces' slots from the profile. Only a companion the app made has slots:
 * Segno's and a registered home's texts are returned exactly as written.
 */
export function renderProfile(text, profile, env = process.env) {
  if (env.RUBATO_COMPANION_MADE_IN_APP !== '1' || typeof text !== 'string') return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => (ONBOARDING_ITEMS.includes(key) ? profile.facts[key] ?? UNSET : whole));
}
