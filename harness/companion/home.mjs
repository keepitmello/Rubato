// Segno's own home: the two records it keeps and the notes it works in.
//
//   <companion home>/                      ~/.rubato/companion unless RUBATO_COMPANION_HOME moves it
//     settings.json state.json following.json messenger/ prompt/   Rubato's own files (unchanged)
//     notes/<name>.md                    Segno's working notes, no expiry
//     memory/YYYY-MM-DD.md               daily: facts, events, decisions, unfinished work
//     memory/diary/YYYY-MM-DD.md         diary: feelings, temperature, memorable exchanges, in its voice
//     wake-wish.json                     when Segno wants to look in next, and why (Roo's wake wish)
//     .rubato/rubato.jsonc               memory.agent = "segno": this folder's own memory store
//
// The method is Roo's (~/.claude/roo-channel/docs/architecture/memory.md, skills daily-logging and
// memory-map): conversation → daily/diary raw → canonical → resident. Only the method travels here;
// the persona and Roo's infrastructure do not.
//
// This file has no local imports on purpose. The same file is staged into the runtime build
// (pi-runtime/features/companion-home) so the companion's tools can write these records, where
// harness/companion is out of reach; anything it imported from beside itself would not follow.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

/** The store this folder writes to (memory.agent); the leads keep their own "rubato" store. */
export const SEGNO_MEMORY_AGENT = 'segno';

export const RECORD_KINDS = Object.freeze(['daily', 'diary', 'note']);
export const NOTE_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

/**
 * The same rule as `companionHome` in companion.mjs, which is its canonical home; it is repeated
 * here because this file also runs where companion.mjs is not staged. `test/home.test.mjs` holds
 * the two together.
 */
export function companionHomeFor(env = process.env) {
  if (env.RUBATO_COMPANION_HOME) return path.resolve(env.RUBATO_COMPANION_HOME);
  return path.join(env.HOME || homedir(), '.rubato', 'companion');
}

export function segnoPaths(env = process.env) {
  const home = companionHomeFor(env);
  const memory = path.join(home, 'memory');
  return {
    home,
    notes: path.join(home, 'notes'),
    memory,
    diary: path.join(memory, 'diary'),
    wake: path.join(home, 'wake-wish.json'),
    projectConfig: path.join(home, '.rubato', 'rubato.jsonc'),
    projectConfigDir: path.join(home, '.rubato'),
  };
}

/** A local date as YYYY-MM-DD. */
export function localDate(at = Date.now()) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** A local clock reading as HH:MM, the heading each entry carries. */
export function localTime(at = Date.now()) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function writeFileAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
}

// ── wake wish ──────────────────────────────────────────────────────────────────────────────
// Roo's wake wish (~/.claude/roo-channel scripts/wake-wish.sh and heartbeat-tick.sh), ported. Segno
// says when it next wants to look in and why. Until then no tick is sent (keeper.mjs counts them
// silently; Roo's still come, the one departure, user 2026-10-20); the first tick at or after that
// time carries action=reflect, reason=wake_wish and the reason. A wish further than six hours from
// when it was set is cut to six.

/** How far a wish reaches from when it was set; beyond this it is cut (clamped). */
export const WAKE_WISH_CAP_MS = 6 * 60 * 60_000;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

/**
 * When a wish for `target` falls: whole minutes from `now`, HH:MM on the local clock (the next one;
 * a time already past today is tomorrow), or an ISO 8601 moment.
 */
export function wakeWishAt(target, now = Date.now()) {
  const raw = String(target ?? '').trim();
  if (/^\d+$/.test(raw)) return now + Number(raw) * 60_000;
  const clock = CLOCK.exec(raw);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) throw new RangeError(`invalid HH:MM: ${raw}`);
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() < now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  const at = Date.parse(raw);
  if (!raw || !Number.isFinite(at)) throw new TypeError('give minutes, HH:MM or an ISO 8601 time');
  return at;
}

/** Records Segno's wake wish; a later one replaces it. The reason is one line of at most 200 characters. */
export function setWakeWish({ target, reason = '' }, { now = Date.now(), env = process.env } = {}) {
  const wish = { schemaVersion: 1, wishAt: new Date(wakeWishAt(target, now)).toISOString(),
    reason: String(reason).split(/\s+/).filter(Boolean).join(' ').slice(0, 200), setAt: new Date(now).toISOString() };
  writeFileAtomic(segnoPaths(env).wake, JSON.stringify(wish, null, 2) + '\n');
  return wish;
}

/** Segno's wake wish as stored, or undefined when there is none or it cannot be read. */
export function readWakeWish(env = process.env) {
  try {
    const wish = JSON.parse(readFileSync(segnoPaths(env).wake, 'utf8'));
    const wishAt = Date.parse(wish?.wishAt);
    const setAt = Date.parse(wish?.setAt);
    if (!Number.isFinite(wishAt) || !Number.isFinite(setAt)) return undefined;
    return { wishAt, setAt, reason: typeof wish.reason === 'string' ? wish.reason : '' };
  } catch { return undefined; }
}

export function clearWakeWish(env = process.env) {
  rmSync(segnoPaths(env).wake, { force: true });
}

/**
 * What a wish means for the tick at `at`: `wait` until its time (cut to six hours after it was
 * set), then `due` with that time and whether it was cut.
 */
export function wakeWishState(wish, at) {
  const effectiveAt = Math.min(wish.wishAt, wish.setAt + WAKE_WISH_CAP_MS);
  return at < effectiveAt ? { mode: 'wait' } : { mode: 'due', effectiveAt, clamped: wish.wishAt > effectiveAt };
}

/**
 * Makes Segno's places and points this folder at its own memory store. A `rubato.jsonc` the person
 * already wrote is left alone: their file is the answer, not ours to overwrite.
 */
export function ensureSegnoHome(env = process.env) {
  const paths = segnoPaths(env);
  mkdirSync(paths.notes, { recursive: true, mode: 0o700 });
  mkdirSync(paths.diary, { recursive: true, mode: 0o700 });
  let config = 'existing';
  if (!existsSync(paths.projectConfig)) {
    writeFileAtomic(paths.projectConfig, JSON.stringify({ memory: { agent: SEGNO_MEMORY_AGENT } }, null, 2) + '\n');
    config = 'written';
  }
  return { ...paths, config };
}

/** The memory store this folder resolves to, when its config names one. */
export function memoryAgentOf(env = process.env) {
  const { projectConfig } = segnoPaths(env);
  try {
    const raw = readFileSync(projectConfig, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const config = JSON.parse(raw);
    return typeof config?.memory?.agent === 'string' ? config.memory.agent : undefined;
  } catch { return undefined; }
}

function fileOf(kind, date, env) {
  const paths = segnoPaths(env);
  if (kind === 'daily') return path.join(paths.memory, `${date}.md`);
  if (kind === 'diary') return path.join(paths.diary, `${date}.md`);
  throw new TypeError(`kind must be daily or diary, not ${String(kind)}`);
}

function noteFileOf(name, env) {
  if (typeof name !== 'string' || !NOTE_NAME.test(name)) throw new TypeError('a note needs a name of lowercase letters, digits and dashes');
  return path.join(segnoPaths(env).notes, `${name}.md`);
}

/** What one record holds today, or an empty string before its first entry. */
export function readRecord(kind, { date, env = process.env } = {}) {
  const file = fileOf(kind, date ?? localDate(), env);
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/** What one note holds, or an empty string. */
export function readNote(name, { env = process.env } = {}) {
  try { return readFileSync(noteFileOf(name, env), 'utf8'); } catch { return ''; }
}

/**
 * Appends one entry, the way Roo's live method keeps them.
 *
 * - daily: `## HH:MM` and a few lines. Written when one stretch of talk closes, so it reads as the
 *   day's skeleton: what was decided, what the user said in their own words, what is still open.
 * - diary: `## <scene>` — a named scene, not a clock time — and a `---` between two entries of the
 *   same day, so one day can be written twice without either part being rewritten.
 * - note: `## HH:MM` under `notes/<name>.md`, Segno's own working land.
 *
 * Nothing is rewritten or reordered: these files are the day's raw material, and what builds on
 * them (memory, a canonical page) reads them rather than replaces them.
 */
export function record(kind, text, { at = Date.now(), date, name, heading, env = process.env } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('a record needs some text');
  if (!RECORD_KINDS.includes(kind)) throw new TypeError(`kind must be one of ${RECORD_KINDS.join(', ')}`);
  const day = date ?? localDate(at);
  const file = kind === 'note' ? noteFileOf(name, env) : fileOf(kind, day, env);
  const body = text.trim();
  const title = typeof heading === 'string' && heading.trim() ? oneLine(heading) : localTime(at);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const separator = kind === 'diary' && existing.trim() ? '\n---\n' : '';
  const entry = `${separator}\n## ${title}\n${body}\n`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, entry, { mode: 0o600 });
  return { kind, file, date: day, at: new Date(at).toISOString() };
}

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Removes one record file; used by tests and by nothing the companion does. */
export function forgetRecord(kind, { date, env = process.env } = {}) {
  rmSync(fileOf(kind, date ?? localDate(), env), { force: true });
}

