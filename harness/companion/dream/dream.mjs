// Segno's dream: once a night, a separate model run re-reads what Segno wrote and said since the
// last dream and places what lasts into its canonical memory, in its own voice. Roo's dream, ported
// (~/.claude/roo-channel: agents-src/memory-maintainer.md, .claude/skills/dreaming/SKILL.md,
// scripts/maintainer_preflight.py, launchd com.roo.cron.memory at 04:07).
//
//   <home>/memory/YYYY-MM-DD.md, diary/       raw: what Segno wrote while awake (home.mjs)
//   <home>/memory/{user,self,us}.md, work/, entities/   canonical, `## 지금` / `## 이야기`
//   <home>/memory/status.md                   status board (Roo memory/현황.md)
//   <home>/memory/to-ask.md                   what to ask the user (Roo inbox/pending-confirmations.md)
//   <home>/memory/weekly/YYYY-WNN.md          the Sunday look back
//   <home>/memory/MEMORY.md                   the resident memory piece, read into Segno's prompt
//   <home>/notes/held.md                      what the user handed over (Roo notes/우용이-챙길거.md)
//   <home>/dream/                             this file's own state, lock, runs and log; not tracked
//
// Nothing here reaches Segno's conversation (intent companion-segno, user item bfe3d27d): the dream is
// a print-mode engine process with its own session folder under dream/runs, it gets file tools only,
// and no code path here calls the engine's wake or notice. Segno meets the result through these files
// and its resident memory piece on its next prompt. Segno's session files are only read.
//
// The child works on a copy of the home's memory/, notes/ and prompt/ under dream/runs/<id>/home and
// never commits. When it is done, only its own places (memory/ and notes/held.md) come back to the
// live home, merged three ways with whatever Segno or the user wrote meanwhile, and the runner commits
// exactly those files (home.mjs commitOwned), the way Roo's dream hands its own paths to
// commit-owned.sh. The user's prompt/ is never written: a child that edits it changes only its copy,
// and the run counts as partial. A child that fails brings nothing home.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { NOTE_ENTRY } from '../../rubato-pi/src/context-notes/protocol.mjs';
import { companionDefaultsDir } from '../../rubato-pi/src/system-prompt.mjs';
import { COMPANION_ENTRY, memoryPiecePath, readPieces, readState } from '../companion.mjs';
import { REPLY_TOOL, SAY_TOOL, commitOwned, landsInside, ensureHomeRepo, localDate, searchSegnoMemory, segnoPaths, segnoSearchEnv } from '../home.mjs';

/** Re-indexes Segno's memory for its search (home.mjs searchSegnoMemory); the engine's service passes it. */
export const reindexSegnoMemory = (env) => searchSegnoMemory('', { index: true, env });

/** Where the questions Segno's search must keep answering live (Roo tests/memory-search-golden.json). */
export const SEARCH_CASES = 'memory/search-golden.json';

/**
 * One search for the weekly check: msearch's structured results on Segno's channel, logged nowhere
 * (Roo's golden check sets ROO_RECALL_LOG=0: a test is not a recall).
 */
export function searchSegnoJson(query, limit, env) {
  const out = execFileSync(env.MSEARCH_BIN || 'msearch', ['--json', '-a', '-k', String(limit), query], {
    cwd: segnoPaths(env).memory, env: { ...segnoSearchEnv(env), ROO_RECALL_LOG: '0' }, encoding: 'utf8', timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

/** Roo's eval default: five results per case unless the case says otherwise (memory-search-eval.py --limit). */
export const SEARCH_CHECK_LIMIT = 5;

/** Roo's result_matches: every expected field is a substring of the result's field. */
const searchMatches = (result, expected) => Object.entries(expected ?? {}).every(([key, value]) => String(result?.[key] ?? '').includes(String(value)));
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * One case as Roo's evaluate_cases judges it: `expected_empty`, `expected_any` in the top `top_k`,
 * `expected_first` and `forbidden_first` on the first result, `forbidden` in the top `top_k`,
 * `min_results` and `max_results`, over `result_limit` results.
 */
export function judgeSearchCase(item, results) {
  const topK = Number.isInteger(item?.top_k) ? item.top_k : SEARCH_CHECK_LIMIT;
  const top = results.slice(0, topK);
  let passed = true;
  if (item?.expected_empty) passed = results.length === 0;
  if (list(item?.expected_any).length) passed = passed && top.some((result) => item.expected_any.some((want) => searchMatches(result, want)));
  if (list(item?.expected_first).length) passed = passed && results.length > 0 && item.expected_first.some((want) => searchMatches(results[0], want));
  if (list(item?.forbidden_first).length) passed = passed && (results.length === 0 || !item.forbidden_first.some((want) => searchMatches(results[0], want)));
  if (list(item?.forbidden).length) passed = passed && !top.some((result) => item.forbidden.some((want) => searchMatches(result, want)));
  if (item && 'min_results' in item) passed = passed && results.length >= Number(item.min_results);
  if (item && 'max_results' in item) passed = passed && results.length <= Number(item.max_results);
  return passed;
}

/**
 * Roo's Sunday search check (scripts/memory-golden-check.sh, memory-search-eval.py), judged as Roo
 * judges (judgeSearchCase). Segno's cases are its own, in memory/search-golden.json (Roo's format,
 * paths as the search reports them, under memory/). With no cases the check says so; without the live
 * search (a sandbox) it says it was not run.
 */
export function weeklySearchCheck(home, search, env = process.env) {
  const casesPath = JSON.parse(env.RUBATO_COMPANION_LAYOUT || '{}').searchCases || SEARCH_CASES;
  let cases;
  try { cases = JSON.parse(readFileSync(path.join(home, casesPath), 'utf8')).cases; } catch { cases = undefined; }
  if (!Array.isArray(cases) || cases.length === 0) return { status: 'no-cases' };
  if (!search) return { status: 'not-run', reason: 'not the live home', total: cases.length };
  const failures = [];
  for (const item of cases) {
    const topK = Number.isInteger(item?.top_k) ? item.top_k : SEARCH_CHECK_LIMIT;
    const resultLimit = Number.isInteger(item?.result_limit) ? item.result_limit : Math.max(SEARCH_CHECK_LIMIT, topK);
    let results;
    try { results = search(String(item?.query ?? ''), resultLimit); }
    catch (error) { return { status: 'error', reason: String(error?.message ?? error).split('\n')[0], total: cases.length }; }
    if (!judgeSearchCase(item, Array.isArray(results) ? results : [])) failures.push(item?.name ?? item?.query);
  }
  return { status: failures.length ? 'failed' : 'passed', passed: cases.length - failures.length, total: cases.length,
    ...(failures.length ? { failures } : {}) };
}

/** Roo's dream runs at 04:07 (launchd com.roo.cron.memory); Segno's starts at or after it, once a day. */
export const DREAM_AT = Object.freeze({ hour: 4, minute: 7 });
/**
 * The model the dream runs on, in fallback order. Roo dreams on Opus with high thinking
 * (agents-src/memory-maintainer.md frontmatter), the same body it is awake in; Segno is awake on
 * anthropic/claude-opus-5-5 too. Sonnet catches a night Opus is out.
 */
export const DREAM_MODELS = Object.freeze([
  Object.freeze({ model: 'anthropic/claude-opus-5-5', thinking: 'high' }),
  Object.freeze({ model: 'anthropic/claude-sonnet-5-5', thinking: 'high' }),
]);
/**
 * How often each part of the dream comes due (Roo maintainer_preflight.py): a little under 24, 48 and
 * 168 hours, so a dream that starts a few minutes earlier than yesterday's does not skip a day.
 */
export const CADENCE_HOURS = Object.freeze({ distill: 20, selfReview: 44, cleanup: 160 });
/** What a first dream reads back, and how far the mistake sweep walks into the past per dream. */
const FIRST_LOOKBACK_DAYS = 7;
const BACKLOG_DAYS = 7;
export const TRANSCRIPT_BUDGET_CHARS = 250_000;
/** Roo's dream run gives the model an hour and a half (scripts/dream-run.sh). */
export const CHILD_TIMEOUT_MS = 90 * 60_000;
/** A lock older than this belongs to a dream that died without cleaning up. */
const STALE_LOCK_MS = 2 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const INSTRUCTIONS = path.join(import.meta.dirname, 'dream.md');
/**
 * What the dream may change: its memory, and Segno's notes (Roo's dream sweeps notes/당김.md and
 * notes/now.md for self-diagnosis and adds to the held list). The user's prompt/ never comes home.
 */
const WRITABLE = (rel) => rel.startsWith('memory/') || rel.startsWith('notes/');
/** The resident memory piece and Roo's guard over it (scripts/memory-core-guard.py). */
const RESIDENT = 'memory/MEMORY.md';
const PROTECTED_SECTION = '잊으면 안 되는 말들';
const QUOTE = /"[^"\n]+"|“[^”\n]+”/g;
/**
 * Roo's ratchet: MEMORY.md may not grow past its smallest committed size plus 200 characters, from
 * the first dream on (the user chose Roo's rule over free growth for a young piece, item 279ef49b).
 * Roo's 5,000-character target is a warning only, as in Roo.
 */
export const MEMORY_GUARD = Object.freeze({ toleranceChars: 200, targetChars: 5_000 });
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
/**
 * On macOS and Linux the engine may run from launchd or a service manager with a bare PATH; the
 * dream's shell still needs git, rg, himalaya and khal. Windows keeps its own Path as it is.
 */
export const FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
/** Counts characters like the guard, for the dream to run with the engine's own node on any machine. */
const COUNT_CHARS = path.join(import.meta.dirname, 'count-chars.mjs');

/** The environment's PATH key: Windows spells it Path, and a copied env object is case-sensitive. */
function pathKey(env, platform) {
  if (platform !== 'win32') return 'PATH';
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path';
}

/** The directories the dream's shell searches for commands. */
export function searchPath(env, platform = process.platform) {
  const value = env[pathKey(env, platform)];
  return value || (platform === 'win32' ? '' : FALLBACK_PATH);
}

export function dreamPaths(env = process.env) {
  const dir = path.join(segnoPaths(env).home, 'dream');
  return { dir, state: path.join(dir, 'state.json'), lock: path.join(dir, 'dream.lock'), runs: path.join(dir, 'runs'),
    log: path.join(dir, 'log'), checks: path.join(dir, 'checks.json') };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Roo's state/maintenance.json: when each part of the dream last covered its ground. */
export function readDreamState(env = process.env) {
  const value = readJson(dreamPaths(env).state);
  return value && typeof value === 'object' ? value : {};
}

/** A moment on the local clock with its offset: 2026-10-21T04:07:00+09:00, the way Roo writes RUN_AT. */
export function localIso(at) {
  const date = new Date(at);
  const pad = (value) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${localDate(at)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

const hm = (at) => { const date = new Date(at); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };

/** ISO week label, YYYY-WNN, for the Sunday look back. */
export function isoWeek(at) {
  const date = new Date(at);
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return localDate(new Date(year, month - 1, day + days, 12).getTime());
}

function dreamTimeOn(at) {
  const date = new Date(at);
  date.setHours(DREAM_AT.hour, DREAM_AT.minute, 0, 0);
  return date.getTime();
}

/**
 * Whether the dream should start now. Once a local day, from 04:07 on (a Mac asleep at 04:07 dreams
 * when the engine next runs that day, as launchd catches up a missed calendar job), only while the
 * companion is on, and never while Segno's conversation is in a turn: its sleep is a turn, and so is
 * any answer it is writing. A busy Segno only delays the dream; the dream never waits on it.
 */
export function dreamDue({ at, state = {}, enabled, busy }) {
  if (!enabled) return { due: false, reason: 'the companion is off' };
  if (at < dreamTimeOn(at)) return { due: false, reason: `before ${String(DREAM_AT.hour).padStart(2, '0')}:${String(DREAM_AT.minute).padStart(2, '0')}` };
  if (state.lastAttemptDate === localDate(at)) return { due: false, reason: 'already dreamed today' };
  if (busy) return { due: false, reason: 'Segno is in a turn' };
  return { due: true };
}

function blockDue(lastAt, hours, at, manual) {
  const last = Date.parse(lastAt ?? '');
  if (manual || !Number.isFinite(last)) return { lastAt: lastAt ?? null, due: true, elapsedH: Number.isFinite(last) ? round1((at - last) / 3_600_000) : null };
  const elapsed = (at - last) / 3_600_000;
  return { lastAt, due: elapsed >= hours, elapsedH: round1(elapsed) };
}
const round1 = (value) => Math.round(value * 10) / 10;

/** The dated record files in one folder: { date, file, mtimeMs }, oldest first. */
function datedFiles(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.map((name) => DATE_FILE.exec(name)?.[1]).filter(Boolean).sort()
    .map((date) => { const file = path.join(dir, `${date}.md`); return { date, file, mtimeMs: statSync(file).mtimeMs }; });
}

/**
 * The dream's plan (Roo's maintainer-preflight): its clock, which parts are due, the raw records to
 * read and the range the mistake sweep covers. Raw records are the daily and diary files written to
 * since the last distill (a first dream reads the last week).
 */
export function planDream({ at, state = {}, env = process.env, manual = false }) {
  const paths = segnoPaths(env);
  const blocks = state.blocks ?? {};
  const today = localDate(at);
  const distill = blockDue(blocks.distill?.lastAt, CADENCE_HOURS.distill, at, manual);
  const selfReview = blockDue(blocks.selfReview?.lastAt, CADENCE_HOURS.selfReview, at, manual);
  const cleanup = blockDue(blocks.cleanup?.lastAt, CADENCE_HOURS.cleanup, at, manual);
  const since = Date.parse(blocks.distill?.lastAt ?? '');
  const firstDay = addDays(today, -FIRST_LOOKBACK_DAYS);
  const fresh = (entry) => (Number.isFinite(since) ? entry.mtimeMs > since : entry.date >= firstDay) && entry.date <= today;
  const daily = datedFiles(paths.memory);
  const diary = datedFiles(paths.diary);
  const relative = (file) => path.relative(paths.home, file);
  const days = [...new Set([...daily, ...diary].map((entry) => entry.date))].sort();

  // Roo's sweep: the days since the last sweep through yesterday, then a week further into the past.
  const yesterday = addDays(today, -1);
  const cleanedThrough = blocks.cleanup?.cleanedThrough;
  const newFrom = cleanedThrough ? addDays(cleanedThrough, 1) : addDays(yesterday, -(BACKLOG_DAYS - 1));
  const newRange = days.filter((date) => date >= newFrom && date <= yesterday);
  const backlogTop = blocks.cleanup?.cleanedBacklogThrough ? addDays(blocks.cleanup.cleanedBacklogThrough, -1) : addDays(newFrom, -1);
  const backlog = days.filter((date) => date <= backlogTop && date >= addDays(backlogTop, -(BACKLOG_DAYS - 1)));

  return {
    runAt: localIso(at), runDate: today, runHm: hm(at), manual,
    sunday: new Date(at).getDay() === 0, isoWeek: isoWeek(at),
    blocks: { distill, selfReview, cleanup },
    raw: { daily: daily.filter(fresh).map((entry) => relative(entry.file)), diary: diary.filter(fresh).map((entry) => relative(entry.file)) },
    cleanup: { cleanedThrough: cleanedThrough ?? null, cleanedBacklogThrough: blocks.cleanup?.cleanedBacklogThrough ?? null, newRange, backlog },
    transcript: null,
    previous: { lastRunAt: state.lastRunAt ?? null, lastStatus: state.lastStatus ?? null, lastRunId: state.lastRunId ?? null },
  };
}

// ── Segno's conversation, read only ─────────────────────────────────────────────────────────────

function agentDirOf(env) {
  const pinned = env.RUBATO_PI_CODING_AGENT_DIR;
  return pinned && pinned.trim() ? pinned : path.join(env.HOME || homedir(), '.rubato-pi', 'agent');
}

const real = (file) => { try { return realpathSync(file); } catch { return path.resolve(file); } };

/** Whether a session file carries the companion marker; it is written right after the header. */
function isSegno(file, id = 'segno') {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8').split('\n').slice(1, 40).some((line) => {
      try {
        const entry = JSON.parse(line);
        return entry?.type === 'custom' && entry.customType === COMPANION_ENTRY && (entry.data?.id ?? 'segno') === id;
      } catch { return false; }
    });
  } finally { closeSync(fd); }
}

function firstLine(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8').split('\n', 1)[0];
  } finally { closeSync(fd); }
}

/**
 * Segno's session files: the conversations the engine keeps in Segno's home that are Segno itself
 * (marked as the companion when created, companion.mjs COMPANION_ENTRY), flat or in a per-folder
 * directory. Another conversation opened in the same folder (a helper, a lead started there) is not
 * Segno and is not read: its words would be heard as Segno's. The dream's own session lives under
 * dream/runs, outside the engine's sessions, so a dream never reads itself.
 */
export function segnoSessionFiles(env = process.env) {
  const root = path.join(agentDirOf(env), 'sessions');
  const home = real(segnoPaths(env).home);
  const files = [];
  const consider = (file) => {
    try {
      const header = JSON.parse(firstLine(file));
      if (header?.type === 'session' && typeof header.cwd === 'string' && real(header.cwd) === home
        && isSegno(file, env.RUBATO_COMPANION_ID || 'segno')) files.push(file);
    } catch { /* not a session file */ }
  };
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) consider(full);
    else if (entry.isDirectory()) {
      for (const nested of readdirSync(full)) if (nested.endsWith('.jsonl')) consider(path.join(full, nested));
    }
  }
  return files.sort();
}

const SESSION_MESSAGE = 'rubato-session-message';

/**
 * What Segno said to the user, as the dream hears it. Everything Segno writes in a turn is its own
 * monologue; the user hears only what it sends with `reply` or says aloud with `say` (home.mjs
 * REPLY_TOOL, SAY_TOOL; Roo's telegram_reply and its voice), so those words exist only as the calls'
 * arguments. Older sessions said it with
 * tell_user or the telegram_* tools, read the same way.
 */
const LEGACY_SAYING = 'tell_user';
const isSaying = (name) => name === REPLY_TOOL || name === SAY_TOOL || name === LEGACY_SAYING || name.startsWith('telegram_');

/**
 * What Segno said to the user through tool calls. In a turn Rubato's clock opened these calls are the
 * only place its words to the user exist, so the dream hears them as Segno's own words.
 */
function sentOf(content, outcomes = new Map()) {
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'toolCall' && typeof block.name === 'string' && isSaying(block.name))
    .map((block) => {
      const args = block.arguments ?? {};
      const said = [args.text, args.voice_text && args.voice_text !== args.text ? `(음성) ${args.voice_text}` : '']
        .filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
      if (Array.isArray(args.files) && args.files.length) said.push(`(파일) ${args.files.map((file) => path.basename(String(file))).join(', ')}`);
      if (typeof args.emoji === 'string') said.push(`(반응) ${args.emoji}`);
      if (!said.length) return '';
      const to = typeof args.to === 'string' || typeof args.to === 'number' ? ` → ${args.name ?? args.to}` : '';
      // Only a call the tool answered without error reached the user; the rest are attempts.
      const outcome = outcomes.get(block.id);
      const mark = outcome === undefined ? ' 확인 안 됨' : outcome.isError ? ' 안 감' : '';
      return `[${block.name}${to}${mark}] ${said.join('\n')}`;
    }).filter(Boolean).join('\n\n');
}
const textOf = (content) => typeof content === 'string' ? content.trim()
  : Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim()).filter(Boolean).join('\n\n') : '';

/**
 * What was said in Segno's conversation after `sinceMs`, oldest first, as the dream reads it: the
 * user's words (app or messenger), Segno's own words, what other conversations and people sent, and a
 * one-line mark where Rubato's clock woke it. Tool calls, tool output and thinking are left out. The
 * files are only read. Returns the text, how many lines of talk it holds, and the newest moment it
 * covers; when the budget runs out the rest waits for the next dream.
 */
export function exportTranscript(files, sinceMs, { budgetChars = TRANSCRIPT_BUDGET_CHARS } = {}) {
  const items = [];
  for (const file of files) {
    const entries = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { continue; }
    }
    // How each tool call ended (its toolResult), so a reply that failed is not heard as said.
    const outcomes = new Map();
    for (const entry of entries) {
      const message = entry?.message;
      if (entry?.type === 'message' && message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
        outcomes.set(message.toolCallId, { isError: message.isError === true });
      }
    }
    for (const entry of entries) {
      const at = typeof entry?.message?.timestamp === 'number' ? entry.message.timestamp : Date.parse(entry?.timestamp ?? '');
      if (!Number.isFinite(at) || at <= sinceMs) continue;
      const item = describe(entry, outcomes);
      if (item) items.push({ at, ...item });
    }
  }
  items.sort((a, b) => a.at - b.at);
  const parts = [];
  let used = 0;
  let messages = 0;
  let coveredThrough;
  let truncated = false;
  for (const item of items) {
    const day = localDate(item.at);
    const text = item.mark ? `\n— ${day} ${hm(item.at)} ${item.mark}\n` : `\n### ${day} ${hm(item.at)} ${item.who}\n\n${item.text}\n`;
    // The mark is a moment, so lines sharing the moment of the last one read go together even past
    // the budget: a cut between them would either lose the rest or read the same lines forever.
    if (parts.length && used + text.length > budgetChars && item.at !== coveredThrough) { truncated = true; break; }
    parts.push(text);
    used += text.length;
    if (!item.mark) messages += 1;
    coveredThrough = item.at;
  }
  return { markdown: `# 깨어 있던 대화\n${parts.join('')}`, messages, coveredThrough, truncated };
}

function describe(entry, outcomes) {
  if (entry?.type === 'message') {
    const role = entry.message?.role;
    const text = role === 'assistant' ? [textOf(entry.message?.content), sentOf(entry.message?.content, outcomes)].filter(Boolean).join('\n\n')
      : textOf(entry.message?.content);
    if (!text) return undefined;
    if (role === 'user') return { who: '사용자 (앱)', text };
    if (role === 'assistant') return { who: '나', text };
    return undefined;
  }
  if (entry?.type !== 'custom_message' || entry.customType !== SESSION_MESSAGE) return undefined;
  const details = entry.details ?? {};
  const text = typeof details.text === 'string' ? details.text.trim() : textOf(entry.content);
  if (details.kind === 'wake') return { mark: `Rubato 시계가 깨움 (${details.what ?? 'wake'})` };
  if (details.kind === 'channel') {
    const from = details.from ?? {};
    return { who: from.isUser ? `사용자 (${from.channel ?? '메신저'})` : `${from.name ?? '다른 사람'} (${from.channel ?? '메신저'})`, text };
  }
  if (!text) return undefined;
  const from = details.from?.title ?? details.from?.sessionId ?? '다른 대화';
  return { who: `${details.kind === 'notice' ? '알림' : '메시지'} · ${from}`, text: text.length > 1200 ? `${text.slice(0, 1200)} …` : text };
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The dream's system prompt: who Segno is (its pieces as the user keeps them, without the tools piece:
 * the dream has none of those tools), its resident memory when the composer does not already carry it,
 * then the dream's own instructions. Roo's dream likewise carries SOUL, IDENTITY, USER, MEMORY and
 * COMPANION above its instruction.
 */
export function composeDreamPrompt({ env = process.env, defaultsDir = companionDefaultsDir(env) } = {}) {
  const pieces = readPieces({ defaultsDir, env }).filter((piece) => piece.id !== 'tools');
  const parts = pieces.map((piece) => piece.personalText ?? piece.defaultText).filter((text) => text?.length > 0);
  if (!pieces.some((piece) => piece.id === 'memory')) {
    const memory = readText(memoryPiecePath(env));
    if (memory) parts.push(memory);
  }
  if (env.RUBATO_COMPANION_ID && env.RUBATO_COMPANION_ID !== 'segno' && !env.RUBATO_COMPANION_DREAM_INSTRUCTIONS)
    throw new TypeError('A registered companion needs its own dream instructions');
  parts.push(readFileSync(env.RUBATO_COMPANION_DREAM_INSTRUCTIONS || INSTRUCTIONS, 'utf8').trim());
  return parts.join('\n\n');
}

/** A file's text exactly as the guard counts it (readText trims). */
function readRaw(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function readText(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/** The resident memory piece starts from Rubato's default frame the first time the dream needs it. */
export function seedResidentMemory({ env = process.env, defaultsDir = companionDefaultsDir(env) } = {}) {
  const file = memoryPiecePath(env);
  if (existsSync(file)) return false;
  if (env.RUBATO_COMPANION_ID && env.RUBATO_COMPANION_ID !== 'segno')
    throw new TypeError('The registered resident memory is missing; refusing another companion’s seed');
  const frame = readText(path.join(defaultsDir, 'memory.pi.md'));
  if (!frame) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, frame + '\n', { flag: 'wx', mode: 0o600 });
  return true;
}

/** The parts of the home the dream works on, copied for it: its memory, its notes and who it is. */
const COPIED = Object.freeze(['memory', 'notes', 'prompt']);

/** Bytes of every file under the copied parts of `root`, keyed by home-relative path. */
function snapshot(root, env = process.env) {
  const out = new Map();
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(root, full).split(path.sep).join('/'), readFileSync(full));
    }
  };
  const resident = path.relative(segnoPaths(env).home, memoryPiecePath(env));
  const parts = [...COPIED, resident, ...JSON.parse(env.RUBATO_COMPANION_DREAM_READ_PATHS || '[]'),
    ...JSON.parse(env.RUBATO_COMPANION_DREAM_WRITE_PATHS || '[]')];
  for (const part of new Set(parts)) {
    const full = path.join(root, part);
    if (!landsInside(root, full)) continue;
    try {
      if (statSync(full).isFile()) out.set(part, readFileSync(full));
      else walk(full);
    } catch { /* a configured optional read path may not exist yet */ }
  }
  return out;
}

/** Writes `files` (a snapshot) under `root`. */
function materialize(root, files) {
  for (const [rel, bytes] of files) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(root, rel), bytes, { mode: 0o600 });
  }
}

const same = (a, b) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && Buffer.compare(a, b) === 0);

/** A three-way text merge (git merge-file): what is live now, what the dream started from, what it wrote. */
function mergeText(live, base, dream, scratch) {
  const files = ['live', 'base', 'dream'].map((name) => path.join(scratch, name));
  writeFileSync(files[0], live);
  writeFileSync(files[1], base ?? Buffer.alloc(0));
  writeFileSync(files[2], dream);
  try { return execFileSync('git', ['merge-file', '-p', ...files], { stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return undefined; }
  finally { for (const file of files) rmSync(file, { force: true }); }
}

/**
 * Brings the dream's work home. Only the dream's own places (memory/ and notes/held.md) come back;
 * a change anywhere else (the user's prompt/, Segno's other notes) is reported and dropped. A file
 * nobody touched while the dream ran takes the dream's version; one Segno or the user wrote to
 * meanwhile is merged three ways, and a merge that conflicts keeps the live file and is reported.
 */
function bringHome({ home, base, dreamed, scratch, guard = () => undefined, writable = WRITABLE }) {
  const applied = [];
  const refused = [];
  const conflicts = [];
  const guarded = [];
  for (const rel of [...new Set([...base.keys(), ...dreamed.keys()])].sort()) {
    const before = base.get(rel);
    const after = dreamed.get(rel);
    if (same(before, after)) continue;
    const file = path.join(home, rel);
    if (!writable(rel) || !landsInside(home, file)) { refused.push(rel); continue; }
    const live = existsSync(file) ? readFileSync(file) : undefined;
    if (same(live, after)) continue;
    let next = after;
    if (!same(live, before)) {
      next = live !== undefined && after !== undefined ? mergeText(live, before, after, scratch) : undefined;
      if (next === undefined) { conflicts.push(rel); continue; }
    }
    const refusal = guard(rel, live, next);
    if (refusal) { guarded.push({ path: rel, ...refusal }); continue; }
    if (next === undefined) rmSync(file, { force: true });
    else { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, next, { mode: 0o600 }); }
    applied.push(rel);
  }
  return { applied, refused, conflicts, guarded };
}

/** Quotes in MEMORY.md's `## 잊으면 안 되는 말들`, with how many times each appears. */
function protectedQuotes(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, '').trim() === PROTECTED_SECTION);
  if (start < 0) return new Map();
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  const counts = new Map();
  for (const quote of lines.slice(start + 1, end < 0 ? undefined : end).join('\n').match(QUOTE) ?? []) counts.set(quote, (counts.get(quote) ?? 0) + 1);
  return counts;
}

/**
 * Roo's memory-core-guard over the resident piece: no quote in `## 잊으면 안 되는 말들` may go, and
 * the piece may not grow past its ratchet (MEMORY_GUARD). Returns why it refuses, or undefined.
 */
export function guardResidentMemory(before, after, baselineChars) {
  if (after === undefined) return { reason: 'MEMORY.md would be deleted' };
  const beforeText = before?.toString('utf8') ?? '';
  const afterText = after.toString('utf8');
  const kept = protectedQuotes(afterText);
  const missing = [...protectedQuotes(beforeText)].filter(([quote, count]) => (kept.get(quote) ?? 0) < count).map(([quote]) => quote);
  const { allowedMaxChars } = residentGuardPlan(beforeText, baselineChars);
  const afterChars = [...afterText].length;
  if (missing.length) return { reason: 'protected quote missing', missing };
  if (afterChars > allowedMaxChars) return { reason: 'MEMORY.md grew past its ratchet', afterChars, allowedMaxChars };
  return undefined;
}

function takeLock(file, at) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at }) + '\n', { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = readJson(file);
      if (!(Number.isFinite(held?.at) && at - held.at > STALE_LOCK_MS)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

/** The child's argv: a print-mode engine run with file tools only and no extensions (Rubato's dream childArgs). */
export function childArgs(launch, { promptPath, sessionDir, rung, launchModel = (model) => model }) {
  return [...launch.prefixArgs, '-p', '--system-prompt', promptPath, '--tools', 'read,bash,edit,write', '--no-extensions',
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--session-dir', sessionDir, '--model', launchModel(rung.model),
    ...(rung.thinking ? ['--thinking', rung.thinking] : []), '꿈을 꿀 시간이야. 계획부터 열어.'];
}

/** Runs the child with its output in a log; resolves to its exit code (null when it was stopped). */
export const spawnLogged = ({ command, args, cwd, env, logPath, timeoutMs }) => new Promise((resolve) => {
  const log = createWriteStream(logPath);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.on('error', (error) => log.write(`\nspawn error: ${String(error)}\n`));
  child.on('close', (code) => { clearTimeout(timer); log.end(); resolve({ code }); });
});

/**
 * One dream over Segno's home. `launch` is how to start an engine child ({ command, prefixArgs, env });
 * `spawnChild` runs it (tests pass a fake that edits files the way a model would); `sessionFiles` lists
 * Segno's conversation files (a sandbox passes copies); `reindex` refreshes Segno's search index after
 * files came home. Search has one index per Mac, so only the live service passes it: a sandbox that
 * re-indexed would replace Segno's index with the sandbox's files. Returns the run
 * record, also kept at dream/runs/<runId>/run.json.
 *
 * The watermarks move only for what the dream covered: a part the child reports as done moves to this
 * run's time (the conversation to the newest moment it read), a skipped or failed part keeps its old
 * mark so the next dream reads the same ground again.
 */
export async function runCompanionDream({ env = process.env, launch, spawnChild = spawnLogged, models = DREAM_MODELS,
  now = Date.now, manual = false, launchModel, childEnv = (value) => value, timeoutMs = CHILD_TIMEOUT_MS,
  defaultsDir = companionDefaultsDir(env), sessionFiles = () => segnoSessionFiles(env), reindex, search } = {}) {
  const at = now();
  const paths = dreamPaths(env);
  const home = segnoPaths(env).home;
  const resident = path.relative(home, memoryPiecePath(env)).split(path.sep).join('/');
  const extraWrites = JSON.parse(env.RUBATO_COMPANION_DREAM_WRITE_PATHS || '[]');
  const writable = rel => WRITABLE(rel) || rel === resident || extraWrites.some(entry =>
    entry.endsWith('/') ? rel.startsWith(entry) : rel === entry);
  const state = readDreamState(env);
  // Everything the dream writes for itself (state, lock, ledger, log, runs and the copy of the home)
  // stays inside the home too: a link anywhere on those paths runs nothing.
  const outward = [paths.state, paths.lock, paths.checks, path.join(paths.log, `${localDate(at)}.md`), path.join(paths.runs, 'run')]
    .find((target) => !landsInside(home, target));
  if (outward) return { status: 'failed', reason: `${outward} leads outside Segno's home through a link` };
  if (!takeLock(paths.lock, at)) return { status: 'busy', reason: 'another dream is running' };
  const runId = `dream-${localIso(at).replace(/[:+]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const runDir = path.join(paths.runs, runId);
  const outDir = path.join(runDir, 'out');
  const base = { runId, startedAt: localIso(at), manual };
  let record;
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    // Today counts as tried from here on: a failure does not start the model again every minute.
    writeJson(paths.state, { ...state, lastAttemptDate: localDate(at) });
    ensureHomeRepo(env);
    seedResidentMemory({ env, defaultsDir });

    const plan = planDream({ at, state, env, manual });
    // The conversation is read every dream: since the last listening when that is due, else since
    // the last distill, for Segno's own words (Roo's voice samples come from the raw talk each night).
    const markOf = (block) => Date.parse(state.blocks?.[block]?.lastAt ?? '');
    const since = markOf(plan.blocks.selfReview.due ? 'selfReview' : 'distill');
    const transcript = exportTranscript(sessionFiles(), Number.isFinite(since) ? since : at - FIRST_LOOKBACK_DAYS * DAY_MS);
    if (transcript.messages > 0) {
      plan.transcript = path.join(runDir, 'transcript.md');
      plan.transcriptFor = plan.blocks.selfReview.due ? 'selfReview' : 'voice';
      writeFileSync(plan.transcript, transcript.markdown, { mode: 0o600 });
    }
    // The seen-mail ledger is the run's copy; it comes home only with the held list it feeds (Roo
    // writes both in one run), so a dream that fails or cannot bring held.md home sees the mail again.
    const checksFile = path.join(runDir, 'checks.json');
    if (existsSync(paths.checks)) writeFileSync(checksFile, readFileSync(paths.checks), { mode: 0o600 });
    plan.checks = { mail: commandExists('himalaya', env), calendar: commandExists('khal', env), file: checksFile };
    plan.workNotes = exportWorkNotes(env, path.join(runDir, 'work-notes.md'), sessionFiles());
    plan.layout = Object.fromEntries(['resident', 'held', 'status', 'diary', 'memory'].map(key =>
      [key, path.relative(home, segnoPaths(env)[key]).split(path.sep).join('/')]));
    plan.dated = hasDatedItems(home, env);
    plan.recall = recallCandidates(env, at);
    plan.memoryGuard = residentGuardPlan(readRaw(memoryPiecePath(env)), readDreamState(env).memoryGuard?.baselineChars, resident);
    // Roo dreams every night. Segno's skips a night only when there is nothing to do at all: no new
    // record or talk, no Sunday, no sweep due, nothing dated that may have passed, no mail or calendar.
    const nothingToDo = !manual && plan.raw.daily.length === 0 && plan.raw.diary.length === 0 && !plan.transcript && !plan.sunday
      && !(plan.blocks.cleanup.due && (plan.cleanup.newRange.length > 0 || plan.cleanup.backlog.length > 0))
      && !plan.dated && !plan.checks.mail && !plan.checks.calendar;
    if (nothingToDo) {
      record = { ...base, status: 'noop', reason: 'nothing to do tonight' };
      return record;
    }
    const promptPath = path.join(runDir, 'system-prompt.md');
    writeFileSync(promptPath, composeDreamPrompt({ env, defaultsDir }), { mode: 0o600 });
    writeJson(path.join(runDir, 'plan.json'), plan);

    // The dream works on its own copy of the home, so nothing it does lands in the live home until
    // the run is over, and then only its own places do (bringHome).
    const workHome = path.join(runDir, 'home');
    const started = snapshot(home, env);
    materialize(workHome, started);
    const attempts = [];
    let ok = false;
    for (const [index, rung] of models.entries()) {
      const logPath = path.join(runDir, `child-${index + 1}.log`);
      const exit = await spawnChild({
        command: launch.command,
        args: childArgs(launch, { promptPath, sessionDir: path.join(runDir, 'session'), rung, launchModel }),
        cwd: workHome,
        env: workEnv(childEnv(env), { ...launch.env, SEGNO_HOME: workHome, COMPANION_HOME: workHome, DREAM_RUN_DIR: runDir, DREAM_OUT_DIR: outDir }),
        logPath, timeoutMs,
      });
      const reported = readJson(path.join(outDir, 'result.json'));
      if (exit.code === 0 && reported) { attempts.push({ model: rung.model, ok: true }); ok = true; break; }
      attempts.push({ model: rung.model, ok: false, error: lastLine(logPath, exit.code, reported) });
      // A rung that died part way may have written files; the next rung starts from them, as a
      // second Roo dream would. Only result.json is cleared, so a stale one is not read as this rung's.
      rmSync(path.join(outDir, 'result.json'), { force: true });
    }
    if (!ok) {
      record = { ...base, status: 'failed', reason: 'every model failed; see child-*.log', attempts };
      return record;
    }
    const result = readJson(path.join(outDir, 'result.json')) ?? {};
    const guardState = readDreamState(env).memoryGuard ?? {};
    const { applied, refused, conflicts, guarded } = bringHome({ home, base: started, dreamed: snapshot(workHome, env), scratch: runDir, writable,
      guard: (rel, live, next) => (rel === resident ? guardResidentMemory(live, next, guardState.baselineChars) : undefined) });
    const message = oneLine(result.message) || `${plan.runDate} 꿈`;
    const commit = applied.length ? commitOwned(applied, `dream: ${message}`, { env }) : undefined;
    const blocks = result.blocks && typeof result.blocks === 'object' ? result.blocks : {};
    const partial = result.status !== 'done' || refused.length > 0 || conflicts.length > 0 || guarded.length > 0;
    // What did not come home (a conflict, or a change outside the dream's places) is not done: the
    // next dream reads the same ground again.
    // What did not come home is read again next night. A MEMORY.md the guard turned back is Roo's
    // failed compaction instead: the night counts, the piece stays as it was, and the run says why.
    const held = conflicts.length > 0 || refused.length > 0;
    if (!held) advance(env, { at, plan, blocks, result, transcript: plan.transcriptFor === 'selfReview' ? transcript : undefined });
    if (applied.includes(resident)) ratchetResident(env, home, started.get(resident));
    if (existsSync(checksFile) && !conflicts.includes(plan.layout.held) && !refused.includes(plan.layout.held)) {
      writeFileSync(paths.checks, readFileSync(checksFile), { mode: 0o600 });
    }
    // Roo's first step, done last here: what the dream wrote is searchable for Segno from now on.
    const index = applied.length && reindex ? firstLineOf(reindex(env)) : undefined;
    // Sunday: Roo's search check, recorded whether or not there was anything to check.
    const searchHealth = plan.sunday ? weeklySearchCheck(home, search && ((query, limit) => search(query, limit, env)), env) : undefined;
    if (searchHealth) writeJson(paths.state, { ...readDreamState(env), weeklySearch: { at: localIso(at), ...searchHealth } });
    appendLog(paths.log, plan.runDate, [readText(path.join(outDir, 'log.md')), searchHealth && `- 검색 점검: ${describeSearchHealth(searchHealth)}`]
      .filter(Boolean).join('\n'), runId);
    record = { ...base, status: partial ? 'partial' : 'done', model: attempts.at(-1).model, attempts, blocks, changed: applied,
      ...(refused.length ? { refused } : {}), ...(conflicts.length ? { conflicts } : {}), ...(guarded.length ? { guarded } : {}),
      ...(held ? { watermarks: 'held' } : {}), ...(index === undefined ? {} : { index }), ...(searchHealth ? { searchHealth } : {}),
      commit: commit ?? null,
      marker: lastLine(path.join(runDir, `child-${attempts.length}.log`), 0) };
    return record;
  } catch (error) {
    record = { ...base, status: 'failed', reason: String(error?.message ?? error) };
    return record;
  } finally {
    const finishedAt = now();
    record = { ...record, finishedAt: localIso(finishedAt) };
    try {
      mkdirSync(runDir, { recursive: true });
      writeJson(path.join(runDir, 'run.json'), record);
      writeJson(paths.state, { ...readDreamState(env), lastRunAt: base.startedAt, lastRunId: runId, lastStatus: record.status,
        lastAttemptDate: localDate(at) });
    } finally { rmSync(paths.lock, { force: true }); }
  }
}

/** What the guard will hold MEMORY.md to tonight, for the dream to see before it writes (plan.memoryGuard). */
export function residentGuardPlan(beforeText, baselineChars, resident = RESIDENT) {
  const currentChars = [...beforeText].length;
  const baseline = Math.min(Number.isFinite(baselineChars) ? baselineChars : currentChars, currentChars);
  return { currentChars, baselineChars: baseline, allowedMaxChars: baseline + MEMORY_GUARD.toleranceChars,
    targetChars: MEMORY_GUARD.targetChars, overTarget: currentChars > MEMORY_GUARD.targetChars,
    countCommand: `"${process.execPath}" "${COUNT_CHARS}" ${resident}`,
    protectedQuotes: [...protectedQuotes(beforeText).keys()] };
}

/** The guard's baseline moves down with the piece and never up (Roo's ratchet). */
function ratchetResident(env, home, before) {
  const chars = (text) => [...text].length;
  const now = chars(readRaw(memoryPiecePath(env)));
  const stored = readDreamState(env).memoryGuard?.baselineChars;
  const start = before === undefined ? now : chars(before.toString('utf8'));
  const baseline = Math.min(Number.isFinite(stored) ? stored : start, start, now);
  writeJson(dreamPaths(env).state, { ...readDreamState(env), memoryGuard: { baselineChars: Math.max(baseline, 0) } });
}

function describeSearchHealth(health) {
  if (health.status === 'no-cases') return `검사할 사례 없음 (${SEARCH_CASES})`;
  if (health.status === 'not-run') return `사례 ${health.total}개, 살아 있는 집이 아니라 안 돌림`;
  if (health.status === 'error') return `실패: ${health.reason}`;
  return `${health.passed}/${health.total} 통과${health.failures ? ` (놓침: ${health.failures.join(', ')})` : ''}`;
}

const firstLineOf = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';

/**
 * What Segno looked up often in the last week (Roo maintainer_preflight.py recall_stats). msearch logs
 * every search in one recall log shared by every channel; each hit's key starts with its channel's
 * prefix (msearch_config.py KEY_PREFIX, `msearch:memory:channel:<id>:`), and Segno's channel is the
 * one its search runs on (home.mjs segnoSearchEnv). As in Roo: searches from the command line only,
 * one search counts a section once however many of its pieces came back, and a section is a
 * candidate when it was found on three different days; most days first, then most searches.
 */
export function recallCandidates(env, at) {
  const search = segnoSearchEnv(env);
  const channel = String(search.MSEARCH_CHANNEL).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  const prefix = search.MSEARCH_KEY_PREFIX || `msearch:memory:channel:${channel}:`;
  let raw;
  try { raw = readFileSync(path.join(search.MSEARCH_STATE_DIR, 'recall-log.jsonl'), 'utf8'); } catch { return []; }
  const grouped = new Map();
  for (const line of raw.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.caller !== 'cli') continue;
    const ts = Date.parse(entry.ts ?? '');
    if (!(at - ts <= 7 * DAY_MS)) continue;
    const found = new Set();
    for (const hit of Array.isArray(entry.hits) ? entry.hits : []) {
      if (!String(hit?.key ?? '').startsWith(prefix) || typeof hit.rel_path !== 'string' || typeof hit.section !== 'string') continue;
      found.add(`${hit.rel_path}\u0000${hit.section}`);
    }
    for (const key of found) {
      const stats = grouped.get(key) ?? { count: 0, days: new Set(), last: 0 };
      stats.count += 1;
      stats.days.add(localDate(ts));
      stats.last = Math.max(stats.last, ts);
      grouped.set(key, stats);
    }
  }
  return [...grouped].filter(([, stats]) => stats.days.size >= 3)
    .sort(([a, x], [b, y]) => y.days.size - x.days.size || y.count - x.count || a.localeCompare(b))
    .map(([key, stats]) => {
      const [relPath, section] = key.split('\u0000');
      return { path: `memory/${relPath}`, section, count: stats.count, distinctDays: stats.days.size, lastHit: localIso(stats.last) };
    });
}

/** Whether a command is on the PATH the dream's shell will have. */
export function commandExists(name, env, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32'
    ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  return searchPath(env, platform).split(delimiter).filter(Boolean).some((dir) => extensions.some((extension) => {
    try { return statSync(path.join(dir, `${name}${extension}`)).isFile(); } catch { return false; }
  }));
}

/** Something dated that may have passed: a line under the held list's dated part or the user's 예약된 것. */
function hasDatedItems(home, env = process.env) {
  const held = readText(segnoPaths(env).held);
  const dated = /^##\s+날짜 있는 거\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(held)?.[1] ?? '';
  if (dated.split('\n').some((line) => /^\s*[-*]\s+\S/.test(line))) return true;
  const booked = /예약된 것:?\s*(.*)$/m.exec(readText(path.join(home, 'memory', 'user.md')))?.[1]?.trim() ?? '';
  return booked !== '' && !/^없음/.test(booked);
}

/**
 * Segno's work notes (Roo's q, user item bfe3d27d), read-only for the dream: the latest text of each
 * note on the branch Segno's conversation is on now. The session journal is where notes live (the
 * engine's notes database is an archive that keeps a rewound branch's notes too), so the branch is
 * walked from the newest entry back to the start. Undefined when there are none.
 */
export function exportWorkNotes(env, target, files = segnoSessionFiles(env)) {
  const { sessionId } = readState(env);
  const file = files.find((candidate) => { try { return JSON.parse(firstLine(candidate))?.id === sessionId; } catch { return false; } });
  if (!file) return undefined;
  const byId = new Map();
  let leaf;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.id !== 'string' || entry.type === 'session') continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
  const notes = new Map();
  for (let entry = leaf; entry; entry = byId.get(entry.parentId)) {
    if (entry.type !== 'custom' || entry.customType !== NOTE_ENTRY) continue;
    const { path: name, text } = entry.data ?? {};
    if (typeof name === 'string' && typeof text === 'string' && !notes.has(name)) notes.set(name, text);
  }
  const kept = [...notes].filter(([, text]) => text.trim()).sort(([a], [b]) => a.localeCompare(b));
  if (!kept.length) return undefined;
  writeFileSync(target, kept.map(([name, text]) => `## ${name}\n\n${text}\n`).join('\n'), { mode: 0o600 });
  return target;
}

/** The child's environment: its copy is its home, so the live home's override does not follow it. */
export function workEnv(env, extra, platform = process.platform) {
  // launchd starts the engine without a locale, and then a shell counts Korean in bytes.
  const locale = platform === 'win32' || env.LC_ALL || env.LC_CTYPE || env.LANG ? {} : { LANG: 'en_US.UTF-8' };
  const out = { ...env, [pathKey(env, platform)]: searchPath(env, platform), ...locale, ...extra };
  delete out.RUBATO_COMPANION_HOME;
  return out;
}

/** Moves each watermark the child covered. */
function advance(env, { at, plan, blocks, result, transcript }) {
  const state = readDreamState(env);
  const next = { ...(state.blocks ?? {}) };
  const runAt = localIso(at);
  if (blocks.distill === 'done') next.distill = { lastAt: runAt };
  if (blocks.selfReview === 'done') {
    const covered = transcript?.truncated && Number.isFinite(transcript.coveredThrough) ? localIso(transcript.coveredThrough) : runAt;
    next.selfReview = { lastAt: covered };
  }
  if (blocks.cleanup === 'done') {
    next.cleanup = { lastAt: runAt,
      cleanedThrough: isDate(result.cleanedThrough) ? result.cleanedThrough : plan.cleanup.newRange.at(-1) ?? plan.cleanup.cleanedThrough,
      cleanedBacklogThrough: isDate(result.cleanedBacklogThrough) ? result.cleanedBacklogThrough
        : plan.cleanup.backlog[0] ?? plan.cleanup.cleanedBacklogThrough };
  }
  if (blocks.weekly === 'done') next.weekly = { lastAt: runAt, week: plan.isoWeek };
  writeJson(dreamPaths(env).state, { ...state, blocks: next });
}

const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

function appendLog(dir, date, text, runId) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(dir, `${date}.md`), `${text ? text : `## 꿈\n- 기록 없음 (${runId})`}\n\n`, { mode: 0o600 });
}

function lastLine(file, code, result) {
  const text = readText(file);
  const line = text.split('\n').map((value) => value.trim()).filter(Boolean).at(-1);
  if (line) return line.length > 240 ? `${line.slice(0, 240)}…` : line;
  if (code === 0 && !result) return 'finished without writing result.json';
  return code === null ? 'stopped without output (timed out or killed)' : `exited with code ${code} and no output`;
}
