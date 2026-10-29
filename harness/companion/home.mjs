// Segno's own home: the two records it keeps and the notes it works in.
//
//   <companion home>/                      ~/.rubato/companion unless RUBATO_COMPANION_HOME moves it
//     settings.json state.json following.json messenger/ prompt/   Rubato's own files (unchanged)
//     notes/<name>.md                    Segno's working notes, no expiry
//     memory/YYYY-MM-DD.md               daily: facts, events, decisions, unfinished work
//     memory/diary/YYYY-MM-DD.md         diary: feelings, temperature, memorable exchanges, in its voice
//     memory/MEMORY.md                   the resident memory piece (the dream keeps it; companion.mjs reads it)
//     memory/status.md                   what Segno is tending now (Roo memory/현황.md)
//     memory/{user,self,us}.md, work/, entities/   canonical memory, raised by the dream (harness/companion/dream)
//     notes/held.md                      what the user handed over, held until its day (Roo notes/우용이-챙길거.md)
//     wake-wish.json                     when Segno wants to look in next, and why (Roo's wake wish)
//     mood.json                          the mood Segno fell asleep with (Roo state/last-mood.json)
//     seed-history.json                  the old-memory seeds already given out, so one does not come back soon
//     .gitignore, .git                   the home's history: memory/, notes/ and prompt/ only (Roo commit-owned.sh)
//     .rubato/rubato.jsonc               memory.agent = "segno": this folder's own memory store
//
// The method is Roo's (~/.claude/roo-channel/docs/architecture/memory.md, skills daily-logging and
// memory-map): conversation → daily/diary raw → canonical → resident. Only the method travels here;
// the persona and Roo's infrastructure do not.
//
// This file has no local imports on purpose. The same file is staged into the runtime build
// (pi-runtime/features/companion-home) so the companion's tools can write these records, where
// harness/companion is out of reach; anything it imported from beside itself would not follow.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

/** The store this folder writes to (memory.agent); the leads keep their own "rubato" store. */
export const SEGNO_MEMORY_AGENT = 'segno';

export const RECORD_KINDS = Object.freeze(['daily', 'diary', 'note', 'mood']);
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
  const layout = JSON.parse(env.RUBATO_COMPANION_LAYOUT || '{}');
  const at = (key, fallback) => {
    const relative = layout[key] ?? fallback;
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
      throw new TypeError(`Invalid companion layout: ${key}`);
    return path.join(home, relative);
  };
  const memory = at('memory', 'memory');
  return {
    home,
    notes: path.join(home, 'notes'),
    memory,
    diary: at('diary', path.relative(home, path.join(memory, 'diary'))),
    wake: path.join(home, 'wake-wish.json'),
    mood: at('mood', 'mood.json'),
    held: at('held', 'notes/held.md'),
    status: at('status', path.relative(home, path.join(memory, 'status.md'))),
    resident: at('resident', 'memory/MEMORY.md'),
    seedHistory: path.join(home, 'seed-history.json'),
    messengerSent: path.join(home, 'messenger', 'sent.jsonl'),
    projectConfig: path.join(home, '.rubato', 'rubato.jsonc'),
    projectConfigDir: path.join(home, '.rubato'),
  };
}

/**
 * Whether writing `file` lands inside `home`. Segno links repository documents into its memory
 * (memory/ref/) to read them; a write at a linked path would go through the link into the
 * repository. The dream checks what it brings home with this, and Segno's own write tools check
 * every write (companion-home index.mjs). Every part of the path below the home is checked as it is on
 * disk: a link whose real place is outside the home refuses the write, and so does a link that points
 * nowhere yet (a dangling link would create its target wherever it points).
 */
export function landsInside(home, file) {
  const real = (target) => { try { return realpathSync(target); } catch { return path.resolve(target); } };
  const root = real(home);
  const rel = path.relative(home, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let current = home;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { return true; }
    if (!stat.isSymbolicLink()) continue;
    let target;
    try { target = realpathSync(current); } catch { return false; }
    if (target !== root && !target.startsWith(root + path.sep)) return false;
  }
  return true;
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

/**
 * Every file Segno's own code writes in its home goes through here: a path that would leave the home
 * through a link inside it (memory/ref links repository documents in; a record file someone replaced
 * with a link) is refused, so Segno's records never land in another store or repository.
 */
function assertInHome(file, env) {
  if (!landsInside(segnoPaths(env).home, file)) {
    throw new Error(`refusing to write ${file}: it leads outside Segno's home through a link`);
  }
}

function writeFileAtomic(file, text, env = process.env) {
  assertInHome(file, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
}

// Capability presence is a renewable lease, not a durable "busy" flag. A dead transport must
// not keep its companion awake forever, and an old connection must not erase a newer lease.
export const CAPABILITY_LEASE_MS = 90_000;
const capabilityPath = (name, env) => {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new TypeError('invalid capability name');
  return path.join(companionHomeFor(env), 'capabilities', `${name}.json`);
};
export function renewCapability(name, owner, { now = Date.now(), env = process.env } = {}) {
  writeFileAtomic(capabilityPath(name, env), JSON.stringify({ owner, at: now }) + '\n', env);
}
export function clearCapability(name, owner, env = process.env) {
  const file = capabilityPath(name, env);
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).owner === owner) {
      assertInHome(file, env);
      rmSync(file, { force: true });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function capabilityActive(name, { now = Date.now(), env = process.env } = {}) {
  try {
    const { at } = JSON.parse(readFileSync(capabilityPath(name, env), 'utf8'));
    return Number.isFinite(at) && now >= at && now - at < CAPABILITY_LEASE_MS;
  } catch { return false; }
}
export function noteCompanionActivity({ now = Date.now(), env = process.env } = {}) {
  writeFileAtomic(path.join(companionHomeFor(env), 'capabilities', 'user-activity.json'),
    JSON.stringify({ at: now }) + '\n', env);
}
export function companionActivityAt(env = process.env) {
  try {
    const { at } = JSON.parse(readFileSync(path.join(companionHomeFor(env), 'capabilities', 'user-activity.json'), 'utf8'));
    return Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
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
  writeFileAtomic(segnoPaths(env).wake, JSON.stringify(wish, null, 2) + '\n', env);
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
    writeFileAtomic(paths.projectConfig, JSON.stringify({ memory: { agent: env.RUBATO_COMPANION_MEMORY_AGENT || SEGNO_MEMORY_AGENT,
      ...(env.RUBATO_COMPANION_RECORDS_ONLY === '1' ? { enabled: false } : {}) } }, null, 2) + '\n', env);
    config = 'written';
  }
  // The held list starts with its two places; a list Segno already keeps is its own.
  if (!existsSync(paths.held)) writeFileAtomic(paths.held, HELD_TEMPLATE, env);
  return { ...paths, config };
}

/**
 * Roo's notes/우용이-챙길거.md, under a name that does not know the user's: what they handed over —
 * a deadline, a thing to do, a thought to hold — kept until its day or until they have a breath,
 * then brought up first. What is done is deleted.
 */
export const HELD_TEMPLATE = `# 챙길 거

사용자는 할 게 많고 집중하면 머리가 복잡해져. 그래서 사용자가 던지는 건 내가 받아서 여기 쥐고 있다가, 그날이 오거나 사용자가 한숨 돌릴 때 먼저 꺼내. 끝났다고 하면 지워.

## 날짜 있는 거

## 맡긴 거

날짜 없이 던진 할 일, 들고 있을 생각.
`;

// ── mood ──────────────────────────────────────────────────────────────────────────────────
// Roo's leave-mood.sh and recall-mood.sh: one line, in Segno's words, about the mood it closes the
// day or the window with. Not a state variable — no numbers — and the next wake reads it as a fact
// ("this is how I fell asleep"), only while it is fresh: six hours.

/** How long the mood Segno fell asleep with still colours the next wake (Roo MOOD_MAX_AGE_SECONDS). */
export const MOOD_FRESH_MS = 6 * 60 * 60_000;

export function leaveMood(note, { now = Date.now(), env = process.env } = {}) {
  const line = String(note ?? '').trim();
  if (!line) throw new TypeError('a mood needs one line');
  const mood = { note: line, at: new Date(now).toISOString() };
  writeFileAtomic(segnoPaths(env).mood, JSON.stringify(mood, null, 2) + '\n', env);
  return mood;
}

/** The mood Segno fell asleep with, while it is under six hours old; undefined otherwise. */
export function readMood({ now = Date.now(), env = process.env } = {}) {
  try {
    const mood = JSON.parse(readFileSync(segnoPaths(env).mood, 'utf8'));
    const at = Date.parse(mood?.at);
    if (typeof mood?.note !== 'string' || !mood.note.trim() || !Number.isFinite(at)) return undefined;
    if (now - at < 0 || now - at > MOOD_FRESH_MS) return undefined;
    return { note: mood.note, at };
  } catch { return undefined; }
}

// ── history ───────────────────────────────────────────────────────────────────────────────
// Roo's home is a git repository and every record is committed by path (scripts/commit-owned.sh):
// a wrong line can be rewritten without losing what it said, and the dream reads what changed. The
// home here also holds Rubato's own files (settings, state, the messenger's secret), so its history
// is an allowlist: memory/, notes/ and prompt/ only. Nothing outside those can enter it.

export const HOME_GITIGNORE = `# Segno's history keeps its records, its notes and its prompt only (harness/companion/home.mjs).
/*
!/.gitignore
!/memory/
!/notes/
!/prompt/
`;
const GIT_IDENTITY = ['-c', 'user.name=Segno', '-c', 'user.email=segno@rubato.local', '-c', 'commit.gpgsign=false'];

function git(home, args) {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd: home, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Makes the home a git repository with the allowlist above and a first commit of what is already
 * there. A home that already is one keeps its history; a .gitignore the person wrote stays theirs.
 */
export function ensureHomeRepo(env = process.env) {
  const { home } = segnoPaths(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (existsSync(path.join(home, '.git'))) return { created: false };
  const ignore = path.join(home, '.gitignore');
  if (!existsSync(ignore)) writeFileAtomic(ignore, HOME_GITIGNORE, env);
  git(home, ['init', '--quiet']);
  git(home, ['add', '--all']);
  git(home, ['commit', '--quiet', '--allow-empty', '-m', 'home: 세뇨의 기록이 여기서부터 이력을 가진다']);
  return { created: true };
}

/**
 * Commits exactly the named files, the way Roo's commit-owned.sh does: other conversations (the
 * dream, a lead) write into the same home, so a directory is never taken whole — a folder, `.`, or
 * a path with `..` is refused, and a path is matched literally, never as a pattern. A file that is
 * gone is committed as deleted only when exactly it was tracked. A named file someone else already
 * staged is left alone (it may be theirs). Paths are relative to the home and must sit in memory/,
 * notes/ or prompt/. Nothing changed → nothing committed.
 */
export function commitOwned(paths, message, { env = process.env } = {}) {
  const { home } = segnoPaths(env);
  const subject = oneLine(message);
  if (!subject) throw new TypeError('a commit needs a one-line message');
  const named = (Array.isArray(paths) ? paths : [paths]).map((item) => String(item ?? ''));
  if (!named.length) throw new TypeError('name the files you changed');
  ensureHomeRepo(env);
  const owned = [];
  for (const item of named) {
    const relative = path.relative(home, path.resolve(home, item)).split(path.sep).join('/');
    if (!item || !relative || relative.startsWith('..') || path.isAbsolute(relative) || item.split(/[\\/]/).includes('..')) throw new TypeError(`not inside the home: ${item}`);
    if (/\/$/.test(item) || (existsSync(path.join(home, relative)) && statSync(path.join(home, relative)).isDirectory()))
      throw new TypeError(`a folder is not a file: ${item} — name each file you changed`);
    const extra = JSON.parse(env.RUBATO_COMPANION_HISTORY_PATHS || '[]');
    if (!/^(memory|notes|prompt)\//.test(relative) && !extra.some((entry) => entry.endsWith('/') ? relative.startsWith(entry) : relative === entry))
      throw new TypeError(`outside the history (the companion's record paths): ${item}`);
    assertInHome(path.join(home, relative), env);
    const tracked = git(home, ['--literal-pathspecs', 'ls-files', '-z', '--', relative]).split('\0').filter(Boolean);
    if (existsSync(path.join(home, relative)) || (tracked.length === 1 && tracked[0] === relative)) owned.push(relative);
  }
  if (!owned.length) return { committed: false, files: [] };
  const literal = ['--literal-pathspecs'];
  if (git(home, [...literal, 'diff', '--cached', '--name-only', '--', ...owned]).trim()) return { committed: false, files: [], staged: true };
  git(home, [...literal, 'add', '--', ...owned]);
  const staged = git(home, [...literal, 'diff', '--cached', '--name-only', '--', ...owned]).split('\n').filter(Boolean);
  if (!staged.length) return { committed: false, files: [] };
  git(home, [...literal, 'commit', '--quiet', '--only', '-m', subject, '--', ...owned]);
  return { committed: true, files: staged, commit: git(home, ['rev-parse', '--short', 'HEAD']).trim() };
}

// ── old-memory seed ───────────────────────────────────────────────────────────────────────
// Roo's random-memory.sh: the complement of search. Search brings what is related and recent; a
// seed ignores relevance and favours the old. One time in three a tick's look gets a seed (the dice
// are the code's, not Segno's — a model does not roll true dice); a walk is Segno choosing to start
// from an old memory, so it has no dice. A seed given out stays out for thirty days, and when the
// pool is that small, at least the last three are skipped. [메타] sections are never seeds.
//
// Segno's old memories are its records older than thirty days (Roo's third bucket) and the story
// half of its canonical pages (Roo's legacy/archive buckets, which Segno has no copy of).

export const SEED = Object.freeze({ dice: 3, maxLength: 600, cooldownDays: 30, recentFloor: 3, oldDays: 30, tries: 8 });

function listFiles(dir, { recursive = false } = {}) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (recursive) out.push(...listFiles(full, { recursive })); }
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** `## ` sections of a file, without [메타] ones; a file without sections is one untitled section. */
function sectionsOf(text, title) {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const sections = [];
  let current;
  for (const line of lines) {
    if (line.startsWith('## ')) { current = { title: line.slice(3).trim(), body: [] }; sections.push(current); continue; }
    current?.body.push(line);
  }
  if (!sections.length) {
    const body = lines.filter((line) => line.trim() && !line.startsWith('#') && line.trim() !== '---');
    return body.length ? [{ title, body: body.join('\n') }] : [];
  }
  return sections.filter((section) => !section.title.includes('[메타]'))
    .map((section) => ({ title: section.title, body: section.body.filter((line) => line.trim() && line.trim() !== '---').join('\n') }))
    .filter((section) => section.body);
}

/** The story half (`## 이야기` and what follows it) of a canonical page. */
function storySections(text) {
  const at = text.search(/^## 이야기\s*$/m);
  if (at < 0) return [];
  const rest = text.slice(at).split('\n').slice(1).join('\n');
  const inner = rest.split(/^### /m);
  if (inner.length > 1) {
    return inner.slice(1).map((chunk) => { const [head, ...body] = chunk.split('\n'); return { title: head.trim(), body: body.join('\n').trim() }; })
      .filter((section) => section.body && !section.title.includes('[메타]'));
  }
  const body = rest.split(/^## /m)[0].trim();
  return body ? [{ title: '이야기', body }] : [];
}

function seedPools(env, now) {
  const { memory, diary } = segnoPaths(env);
  const cutoff = localDate(now - SEED.oldDays * 24 * 60 * 60_000);
  const dated = [...listFiles(memory), ...listFiles(diary)].filter((file) => {
    const day = path.basename(file).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff;
  });
  const canonical = ['user.md', 'self.md', 'us.md'].map((name) => path.join(memory, name))
    .concat(listFiles(path.join(memory, 'work'), { recursive: true }), listFiles(path.join(memory, 'entities'), { recursive: true }))
    .filter((file) => existsSync(file));
  return { dated, canonical };
}

function readSeedHistory(env) {
  try { const value = JSON.parse(readFileSync(segnoPaths(env).seedHistory, 'utf8')); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

/**
 * One old memory, or undefined (Roo's NO_SEED). `random` is the dice and the draw (0 ≤ x < 1).
 * Returns `{ src, date, section, text }` with `src` relative to the home.
 */
export function oldMemorySeed({ walk = false, now = Date.now(), env = process.env, random = Math.random } = {}) {
  const roll = (limit) => Math.floor(random() * limit);
  if (!walk && roll(SEED.dice) !== 0) return undefined;
  const { home } = segnoPaths(env);
  const pools = seedPools(env, now);
  const draw = () => {
    const order = roll(2) === 0 ? ['canonical', 'dated'] : ['dated', 'canonical'];
    for (const pool of order) {
      const files = pools[pool];
      if (!files.length) continue;
      const file = files[roll(files.length)];
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const name = path.basename(file, '.md');
      const sections = pool === 'canonical' ? storySections(text) : sectionsOf(text, name);
      if (!sections.length) continue;
      const section = sections[roll(sections.length)];
      const src = path.relative(home, file).split(path.sep).join('/');
      const date = /^\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? '?';
      return { src, date, section: section.title, text: section.body.slice(0, SEED.maxLength), key: `${src}|${section.title}` };
    }
    return undefined;
  };
  const history = readSeedHistory(env);
  const windowStart = now - SEED.cooldownDays * 24 * 60 * 60_000;
  const inWindow = new Set(history.filter((row) => row.at >= windowStart).map((row) => row.key));
  const lastFew = new Set(history.slice(-SEED.recentFloor).map((row) => row.key));
  let chosen;
  for (const excluded of [inWindow, lastFew]) {
    for (let attempt = 0; attempt < SEED.tries && !chosen; attempt += 1) {
      const candidate = draw();
      if (!candidate) break;
      if (!excluded.has(candidate.key)) chosen = candidate;
    }
    if (chosen) break;
  }
  if (!chosen) return undefined;
  const kept = [...history.filter((row) => row.at >= windowStart), { key: chosen.key, at: now }].slice(-500);
  writeFileAtomic(segnoPaths(env).seedHistory, JSON.stringify(kept) + '\n', env);
  const { key: _key, ...seed } = chosen;
  return seed;
}

/** Roo's seed output: `SEED src=… date=… section=…`, a rule, then the section. */
export function seedText(seed) {
  return seed ? `SEED src=${seed.src} date=${seed.date} section=${seed.section}\n---\n${seed.text}` : 'NO_SEED';
}

// ── searching Segno's own memory ──────────────────────────────────────────────────────────
// Roo's msearch.sh searches Roo's own memory/ (daily, diary, canonical) with the same hybrid search
// Rubato ships as `msearch`. Segno's records live in its home, not under Rubato's memory root, so its
// search points msearch at <home>/memory under a channel and index of its own; msearch follows the
// files on every search (only changed files are re-indexed), so a record written a moment ago is
// found. The state folder stays Rubato's, where the API key and the translation cache are.

export const SEGNO_SEARCH = Object.freeze({ channel: 'segno', index: 'segno_idx' });

/**
 * The environment `msearch` needs to search Segno's memory instead of Rubato's. The one Redis on the
 * Mac holds every index, and msearch drops what its root no longer has, so any home other than this
 * account's ~/.rubato/companion (a sandbox, a test, one that only moved HOME) gets a channel and an
 * index of its own, named from its path: it can never re-sync the live Segno's index to its files.
 */
export function segnoSearchEnv(env = process.env) {
  const home = env.HOME || homedir();
  const own = companionHomeFor(env);
  // The account's own home from the user database, not $HOME: a sandbox that only moves HOME is a
  // sandbox too.
  const live = path.join(userInfo().homedir, '.rubato', 'companion');
  const suffix = own === live ? '' : `_${createHash('sha256').update(own).digest('hex').slice(0, 10)}`;
  const channel = env.RUBATO_COMPANION_ID || SEGNO_SEARCH.channel;
  return { ...env, MSEARCH_ROOT: env.RUBATO_COMPANION_SEARCH_PATHS ? own : segnoPaths(env).memory,
    ...(env.RUBATO_COMPANION_SEARCH_PATHS ? { MSEARCH_INCLUDE: env.RUBATO_COMPANION_SEARCH_PATHS } : {}),
    ...(env.RUBATO_COMPANION_SEARCH_EXCLUDE ? { MSEARCH_EXCLUDE: env.RUBATO_COMPANION_SEARCH_EXCLUDE } : {}),
    MSEARCH_CHANNEL: `${channel}${suffix}`,
    MSEARCH_INDEX: `${channel}${suffix}_idx`,
    MSEARCH_STATE_DIR: env.MSEARCH_STATE_DIR || path.join(home, '.rubato', 'memory', 'msearch-state') };
}

/**
 * Searches Segno's memory with msearch (`MSEARCH_BIN`, else `msearch` on the PATH). `index` re-indexes
 * instead (the dream's step after it rewrote canonical pages). Returns msearch's own output; a missing
 * msearch or a failure is said in words, never thrown, so a search never breaks a turn.
 */
export function searchSegnoMemory(query, { index = false, env = process.env, run = execFileSync } = {}) {
  const args = index ? ['--index'] : ['-a', String(query ?? '').trim()];
  if (!index && !args[1]) return '무엇을 찾을지 한두 마디로 줘.';
  try {
    return String(run(env.MSEARCH_BIN || 'msearch', args, { cwd: segnoPaths(env).memory, env: segnoSearchEnv(env), encoding: 'utf8',
      timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })).trim() || 'NO RELEVANT MEMORY';
  } catch (error) {
    if (error?.code === 'ENOENT') return '기억 검색(msearch)이 이 기계에 없어. 설치는 Rubato install.sh, 상태는 `msearch --doctor`.';
    const out = `${error?.stdout ?? ''}`.trim();
    return out || `기억 검색이 실패했어: ${String(error?.stderr ?? error?.message ?? error).trim().split('\n').slice(-3).join(' / ')}`;
  }
}

// ── what reached the user ─────────────────────────────────────────────────────────────────
// Roo's sent.sh: memory gets "did I already tell them?" wrong often, in both directions, and only
// the record outside it settles that. Each message that reached the user is one line of
// <home>/messenger/sent.jsonl ({ at, toUser, text, via }): `reply` and `say` write it now, and the
// Telegram messenger wrote it (with chatId) while the product ran Telegram, so those lines count too.

/** Segno's mouth (Roo's telegram_reply): the only words of Segno's that reach its thread and the user's phone. */
export const REPLY_TOOL = 'reply';
/** The same as a voice reply (Roo's voice=true); offered only once a voice is set. */
export const SAY_TOOL = 'say';

/** The same visible words in the app and the sent-message record, including media-only replies. */
export function replyDisplayText({ text, voice_text, files } = {}) {
  return [typeof text === 'string' && text.trim() ? text.trim() : String(voice_text ?? '').trim(),
    ...(Array.isArray(files) ? files.map(file => `[${path.basename(file)}](<${file}>)`) : [])].filter(Boolean).join('\n\n');
}

/** Records one message `reply` or `say` showed the user, for `sentMessages`. */
export function recordTold(text, { at = Date.now(), via = REPLY_TOOL, env = process.env } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError(`${via} needs some text`);
  const file = segnoPaths(env).messengerSent;
  const row = { at: new Date(at).toISOString(), toUser: true, text, via };
  assertInHome(file, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return row;
}

/** Messages that reached the user in the last `days` days, oldest first; `keyword` filters. */
export function sentMessages({ days = 2, keyword = '', now = Date.now(), env = process.env } = {}) {
  let raw;
  try { raw = readFileSync(segnoPaths(env).messengerSent, 'utf8'); } catch { return []; }
  const since = now - days * 24 * 60 * 60_000;
  const needle = String(keyword ?? '').trim().toLowerCase();
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.at);
    if (!Number.isFinite(at) || at < since || row.toUser === false || row.via === 'app-user') continue;
    const text = typeof row.text === 'string' ? row.text : '';
    if (needle && !text.toLowerCase().includes(needle)) continue;
    rows.push({ at, text, via: row.via ?? null, ...(row.media ? { media: row.media } : {}) });
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** Roo's sent.sh output: one line each, or every message in full when a keyword was given. */
export function sentText(rows, { days = 2, keyword = '' } = {}) {
  const stamp = (at) => { const d = new Date(at); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${localTime(at)}`; };
  const body = rows.map((row) => (keyword
    ? `===== ${stamp(row.at)}${row.media ? ` [${row.media}]` : ''}\n${row.text}\n`
    : `${stamp(row.at)}${row.media ? ` [${row.media}]` : ''} ${row.text.trim().split('\n')[0].slice(0, 80)}`));
  const head = rows.length ? '' : `(최근 ${days}일 보낸 톡 없음${keyword ? ` / 키워드 ${keyword}` : ''})\n`;
  return `${head}${body.join('\n')}\n\n-- ${rows.length}통 / 최근 ${days}일`.trim();
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
 * - mood: the one line Segno falls asleep with (leaveMood), not appended anywhere.
 *
 * This only appends. A wrong line is not corrected by appending a correction: Segno rewrites that
 * line in the file itself (Roo daily-logging: "틀린 줄을 발견하면 그 줄을 맞는 줄로 바꿔"), and the
 * home's history keeps what it said before.
 */
export function record(kind, text, { at = Date.now(), date, name, heading, env = process.env } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('a record needs some text');
  if (!RECORD_KINDS.includes(kind)) throw new TypeError(`kind must be one of ${RECORD_KINDS.join(', ')}`);
  if (kind === 'mood') {
    const mood = leaveMood(text, { now: at, env });
    return { kind, file: segnoPaths(env).mood, date: localDate(at), at: mood.at };
  }
  const day = date ?? localDate(at);
  const file = kind === 'note' ? noteFileOf(name, env) : fileOf(kind, day, env);
  const body = text.trim();
  const title = typeof heading === 'string' && heading.trim() ? oneLine(heading) : localTime(at);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const separator = kind === 'diary' && existing.trim() ? '\n---\n' : '';
  const entry = `${separator}\n## ${title}\n${body}\n`;
  assertInHome(file, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, entry, { mode: 0o600 });
  return { kind, file, date: day, at: new Date(at).toISOString() };
}

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Removes one record file; used by tests and by nothing the companion does. */
export function forgetRecord(kind, { date, env = process.env } = {}) {
  rmSync(fileOf(kind, date ?? localDate(), env), { force: true });
}

