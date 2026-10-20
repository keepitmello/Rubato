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
// The child never commits. It lists the files it changed (result.json) and the runner commits exactly
// those (home.mjs commitOwned), the way Roo's dream hands its own paths to commit-owned.sh. Files under
// prompt/ are the user's and never change here: the runner restores them byte for byte if a child
// touched them, and the run counts as partial.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { companionDefaultsDir } from '../../rubato-pi/src/system-prompt.mjs';
import { memoryPiecePath, readPieces } from '../companion.mjs';
import { commitOwned, ensureHomeRepo, localDate, segnoPaths } from '../home.mjs';

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
export const CHILD_TIMEOUT_MS = 45 * 60_000;
/** A lock older than this belongs to a dream that died without cleaning up. */
const STALE_LOCK_MS = 2 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const INSTRUCTIONS = path.join(import.meta.dirname, 'dream.md');
/** What the dream may change: its memory, and the held list it adds to. Everything else stays. */
const WRITABLE = (rel) => rel.startsWith('memory/') || rel === 'notes/held.md';
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export function dreamPaths(env = process.env) {
  const dir = path.join(segnoPaths(env).home, 'dream');
  return { dir, state: path.join(dir, 'state.json'), lock: path.join(dir, 'dream.lock'), runs: path.join(dir, 'runs'),
    log: path.join(dir, 'log') };
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

function firstLine(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8').split('\n', 1)[0];
  } finally { closeSync(fd); }
}

/**
 * Segno's session files: every conversation the engine keeps whose folder is Segno's home (its
 * windows and any copy of it), flat or in a per-folder directory. The dream's own session lives under
 * dream/runs, outside the engine's sessions, so a dream never reads itself.
 */
export function segnoSessionFiles(env = process.env) {
  const root = path.join(agentDirOf(env), 'sessions');
  const home = real(segnoPaths(env).home);
  const files = [];
  const consider = (file) => {
    try {
      const header = JSON.parse(firstLine(file));
      if (header?.type === 'session' && typeof header.cwd === 'string' && real(header.cwd) === home) files.push(file);
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
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const at = typeof entry?.message?.timestamp === 'number' ? entry.message.timestamp : Date.parse(entry?.timestamp ?? '');
      if (!Number.isFinite(at) || at <= sinceMs) continue;
      const item = describe(entry);
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
    if (parts.length && used + text.length > budgetChars) { truncated = true; break; }
    parts.push(text);
    used += text.length;
    if (!item.mark) messages += 1;
    coveredThrough = item.at;
  }
  return { markdown: `# 깨어 있던 대화\n${parts.join('')}`, messages, coveredThrough, truncated };
}

function describe(entry) {
  if (entry?.type === 'message') {
    const role = entry.message?.role;
    const text = textOf(entry.message?.content);
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
  parts.push(readFileSync(INSTRUCTIONS, 'utf8').trim());
  return parts.join('\n\n');
}

function readText(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/** The resident memory piece starts from Rubato's default frame the first time the dream needs it. */
export function seedResidentMemory({ env = process.env, defaultsDir = companionDefaultsDir(env) } = {}) {
  const file = memoryPiecePath(env);
  if (existsSync(file)) return false;
  const frame = readText(path.join(defaultsDir, 'memory.pi.md'));
  if (!frame) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, frame + '\n', { flag: 'wx', mode: 0o600 });
  return true;
}

/** Bytes of every file under `dir`, keyed by home-relative path. */
function snapshot(home, dir) {
  const out = new Map();
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(home, full), readFileSync(full));
    }
  };
  walk(path.join(home, dir));
  return out;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Puts prompt/ back exactly as it was; returns the paths that had changed. */
function restorePrompt(home, before) {
  const after = snapshot(home, 'prompt');
  const touched = [];
  for (const [rel, bytes] of before) {
    if (after.get(rel) && digest(after.get(rel)) === digest(bytes)) continue;
    mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    writeFileSync(path.join(home, rel), bytes);
    touched.push(rel);
  }
  for (const rel of after.keys()) {
    if (before.has(rel)) continue;
    rmSync(path.join(home, rel), { force: true });
    touched.push(rel);
  }
  return touched;
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
 * Segno's conversation files (a sandbox passes copies). Returns the run
 * record, also kept at dream/runs/<runId>/run.json.
 *
 * The watermarks move only for what the dream covered: a part the child reports as done moves to this
 * run's time (the conversation to the newest moment it read), a skipped or failed part keeps its old
 * mark so the next dream reads the same ground again.
 */
export async function runCompanionDream({ env = process.env, launch, spawnChild = spawnLogged, models = DREAM_MODELS,
  now = Date.now, manual = false, launchModel, childEnv = (value) => value, timeoutMs = CHILD_TIMEOUT_MS,
  defaultsDir = companionDefaultsDir(env), sessionFiles = () => segnoSessionFiles(env) } = {}) {
  const at = now();
  const paths = dreamPaths(env);
  const home = segnoPaths(env).home;
  const state = readDreamState(env);
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
    let transcript;
    if (plan.blocks.selfReview.due) {
      const since = Date.parse(state.blocks?.selfReview?.lastAt ?? '');
      transcript = exportTranscript(sessionFiles(), Number.isFinite(since) ? since : at - FIRST_LOOKBACK_DAYS * DAY_MS);
      if (transcript.messages > 0) {
        plan.transcript = path.join(runDir, 'transcript.md');
        writeFileSync(plan.transcript, transcript.markdown, { mode: 0o600 });
      }
    }
    const nothingNew = !manual && plan.raw.daily.length === 0 && plan.raw.diary.length === 0 && !plan.transcript && !plan.sunday;
    if (nothingNew) {
      record = { ...base, status: 'noop', reason: 'nothing new since the last dream' };
      return record;
    }
    const promptPath = path.join(runDir, 'system-prompt.md');
    writeFileSync(promptPath, composeDreamPrompt({ env, defaultsDir }), { mode: 0o600 });
    writeJson(path.join(runDir, 'plan.json'), plan);

    const promptBefore = snapshot(home, 'prompt');
    const attempts = [];
    let ok = false;
    for (const [index, rung] of models.entries()) {
      const logPath = path.join(runDir, `child-${index + 1}.log`);
      const result = await spawnChild({
        command: launch.command,
        args: childArgs(launch, { promptPath, sessionDir: path.join(runDir, 'session'), rung, launchModel }),
        cwd: home,
        env: { ...childEnv(env), ...launch.env, SEGNO_HOME: home, DREAM_RUN_DIR: runDir, DREAM_OUT_DIR: outDir },
        logPath, timeoutMs,
      });
      const result_ = readJson(path.join(outDir, 'result.json'));
      if (result.code === 0 && result_) { attempts.push({ model: rung.model, ok: true }); ok = true; break; }
      attempts.push({ model: rung.model, ok: false, error: lastLine(logPath, result.code, result_) });
      // A rung that died part way may have written files; the next rung starts from them, as a
      // second Roo dream would. Only result.json is cleared, so a stale one is not read as this rung's.
      rmSync(path.join(outDir, 'result.json'), { force: true });
    }
    const promptTouched = restorePrompt(home, promptBefore);
    if (!ok) {
      record = { ...base, status: 'failed', reason: 'every model failed; see child-*.log', attempts, promptTouched };
      return record;
    }
    const result = readJson(path.join(outDir, 'result.json')) ?? {};
    const listed = Array.isArray(result.changed) ? result.changed.filter((rel) => typeof rel === 'string') : [];
    const clean = (rel) => path.normalize(rel).replace(/^\.\/+/, '');
    const owned = [...new Set(listed.map(clean))].filter((rel) => !path.isAbsolute(rel) && !rel.startsWith('..') && WRITABLE(rel));
    const refused = listed.map(clean).filter((rel) => !owned.includes(rel));
    const message = oneLine(result.message) || `${plan.runDate} 꿈`;
    const commit = owned.length ? commitOwned(owned, `dream: ${message}`, { env }) : undefined;
    const blocks = result.blocks && typeof result.blocks === 'object' ? result.blocks : {};
    const partial = result.status !== 'done' || promptTouched.length > 0 || refused.length > 0;
    advance(env, { at, plan, blocks, result, transcript });
    appendLog(paths.log, plan.runDate, readText(path.join(outDir, 'log.md')), runId);
    record = { ...base, status: partial ? 'partial' : 'done', model: attempts.at(-1).model, attempts, blocks, changed: owned,
      ...(refused.length ? { refused } : {}), ...(promptTouched.length ? { promptTouched } : {}), commit: commit ?? null,
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
