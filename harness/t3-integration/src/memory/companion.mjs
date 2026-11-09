// The memory page's view of a companion's own records (Segno, and any other registered companion
// where its home has the same files). Read-only: the companion's records change only through the
// companion, so this module never writes inside its home. What the page sends Segno goes into
// Segno's conversation as the person's own message (the web client starts that turn), and the only
// thing kept here is which line the person already answered or asked about, under ~/.rubato/cache.
//
//   <home>/memory/status.md            status board (layout key `status`; Roo memory/현황.md)
//   <home>/memory/to-ask.md            what the companion wants to ask the person (layout `toAsk`)
//   <home>/memory/user.md, us.md       what it knows about the person and about the two of them
//   <home>/memory/YYYY-MM-DD.md        daily records; <diary>/YYYY-MM-DD.md the diary (layout `diary`)
//   <home>/memory/weekly/YYYY-WNN.md   the weekly look back
//   <home>/memory/entities/*.md        people and companies (front matter `type: entity`)
//   <home>/dream/state.json, runs/     the companion's own nightly dream
//   <home>/.git                        the home's history (memory/, notes/, prompt/)
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const companionDir = path.resolve(here, '..', '..', '..', 'companion');

const DAY = /^(\d{4}-\d{2}-\d{2})\.md$/;
const WEEK = /^(\d{4}-W\d{2})\.md$/;
const SHA = /^[0-9a-f]{7,64}$/;
const ITEM_ID = /^[a-z]+-[0-9a-f]{12}$/;
const SEARCH_MAX = 40;
const FILE_LIMIT = 1024 * 1024;
const CHANGES_MAX = 50;

export class CompanionMemoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message) => new CompanionMemoryError(400, 'bad-request', message);

/** A stable id for one line: what kind it is and a hash of where it sits and what it says. */
export function itemId(kind, file, text) {
  return `${kind}-${createHash('sha1').update(`${file}\n${text}`).digest('hex').slice(0, 12)}`;
}

/**
 * The bullets of a markdown file, by section. A bullet's indented continuation lines belong to it.
 * `# ` is the file's title; every `## ` opens a section; text before the first section goes to a
 * section with an empty title.
 */
export function bulletsBySection(text) {
  const sections = [];
  let current = null;
  let bullet = null;
  const open = (title) => {
    current = { title, items: [], paragraphs: [] };
    sections.push(current);
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      bullet = null;
      if (heading[1].length >= 2) open(heading[2].trim());
      continue;
    }
    if (!current) open('');
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      bullet = { text: item[1].trim() };
      current.items.push(bullet);
    } else if (bullet && /^\s+\S/.test(line)) {
      bullet.text += ` ${line.trim().replace(/^[-*]\s+/, '')}`;
    } else if (line.trim() !== '') {
      bullet = null;
      if (!line.startsWith('>')) current.paragraphs.push(line.trim());
    } else bullet = null;
  }
  return sections.filter((section) => section.items.length > 0 || section.paragraphs.length > 0);
}

/** "text (daily 10-22·10-23)" → { text, refs: "daily 10-22·10-23" }: the trailing note of where it came from. */
export function splitRefs(text) {
  const match = /^(.*\S)\s*\(([^()]*)\)\s*$/.exec(text);
  if (!match || match[2].length > 120) return { text, refs: null };
  return { text: match[1], refs: match[2] };
}

function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean);
    else value = value.replace(/^(['"])(.*)\1$/, '$2');
    fields[field[1]] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

/** A daily record's headline: its section titles, without the time each opens with. */
export function dailyHeadline(text) {
  const titles = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (!heading) continue;
    const title = heading[1].trim();
    const colon = title.indexOf(': ');
    titles.push(colon > 0 && colon < 30 ? title.slice(colon + 2) : title);
  }
  return titles.join(' · ') || firstSentence(text);
}

function firstSentence(text) {
  const body = frontMatter(String(text ?? '')).body;
  for (const line of body.split(/\r?\n/)) {
    const value = line.trim();
    if (value === '' || value.startsWith('#') || value.startsWith('>')) continue;
    const plain = value.replace(/^[-*]\s+/, '');
    const end = plain.search(/[.!?。](\s|$)/);
    return end > 0 && end < 160 ? plain.slice(0, end + 1) : plain.slice(0, 160);
  }
  return '';
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, home: string, cacheDir: string,
 *   loadCompanions?: () => Promise<{ list: Function, envOf: Function }>,
 *   run: (argv: string[], options?: object) => Promise<{code: number, stdout: string, stderr: string}> }} options
 */
export function createCompanionMemory(options) {
  const env = options.env ?? process.env;
  const run = options.run;
  const sentFile = path.join(options.cacheDir, 'companion-sent.json');

  const loadCompanions = options.loadCompanions ?? (async () => {
    const registry = await import(pathToFileURL(path.join(companionDir, 'registry.mjs')).href);
    const home = await import(pathToFileURL(path.join(companionDir, 'home.mjs')).href);
    return {
      list: () => registry.listCompanions(env),
      paths: (id) => home.segnoPaths(registry.companionEnv(id, env)),
    };
  });

  // The registered companions and where each keeps its records.
  async function profile(companionId) {
    const id = companionId ?? 'segno';
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw bad('Companion is not valid.');
    let registry;
    try { registry = await loadCompanions(); }
    catch (error) { throw new CompanionMemoryError(500, 'companion-unavailable', `The companion registry could not load: ${error.message}`); }
    let profiles;
    try { profiles = registry.list(); }
    catch (error) { throw new CompanionMemoryError(500, 'companion-registry', error.message); }
    const found = profiles.find((entry) => entry.id === id);
    if (!found) throw new CompanionMemoryError(404, 'no-companion', `No companion named ${id}.`);
    const paths = registry.paths(id);
    const layout = found.layout ?? {};
    const inHome = (relative, fallback) => {
      const value = typeof relative === 'string' && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..') ? relative : fallback;
      return path.join(paths.home, value);
    };
    return {
      id: found.id,
      title: found.title,
      home: paths.home,
      memory: paths.memory,
      diary: paths.diary,
      status: paths.status,
      toAsk: inHome(layout.toAsk, path.relative(paths.home, path.join(paths.memory, 'to-ask.md'))),
      weekly: path.join(paths.memory, 'weekly'),
      entities: path.join(paths.memory, 'entities'),
      user: path.join(paths.memory, 'user.md'),
      us: path.join(paths.memory, 'us.md'),
      dream: path.join(paths.home, 'dream'),
    };
  }

  async function companions() {
    const registry = await loadCompanions();
    const list = [];
    for (const entry of registry.list()) {
      const paths = registry.paths(entry.id);
      list.push({ id: entry.id, title: entry.title, hasMemory: existsSync(paths.memory) });
    }
    return { companions: list };
  }

  async function text(file) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile()) return undefined;
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    }
  }
  async function list(dir) {
    try { return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  }
  const rel = (where, file) => path.relative(where.home, file).split(path.sep).join('/');
  const git = (where, args) => run(['git', '-C', where.home, '-c', 'core.quotePath=false', ...args]);

  async function lastChange(where, file) {
    if (!existsSync(path.join(where.home, '.git'))) return null;
    const log = await git(where, ['log', '-1', '--format=%cI', '--', rel(where, file)]);
    return log.code === 0 && log.stdout.trim() !== '' ? log.stdout.trim() : null;
  }

  async function readSent() {
    try { return JSON.parse(await readFile(sentFile, 'utf8')); }
    catch { return {}; }
  }

  async function status(where) {
    const body = await text(where.status);
    if (body === undefined) return null;
    const file = rel(where, where.status);
    return {
      path: file,
      updatedAt: await lastChange(where, where.status),
      sections: bulletsBySection(body).map((section) => ({
        title: section.title,
        items: section.items.map((item) => ({ id: itemId('status', file, item.text), ...splitRefs(item.text) })),
      })).filter((section) => section.items.length > 0),
    };
  }

  // Segno marks a suggested line for its own prompt piece "[user 조각 제안]": a proposal, not a question.
  const PROPOSAL = /^\[[^\]]*(제안|proposal)[^\]]*\]\s*/i;
  async function questions(where) {
    const body = await text(where.toAsk);
    if (body === undefined) return null;
    const file = rel(where, where.toAsk);
    return {
      path: file,
      updatedAt: await lastChange(where, where.toAsk),
      items: bulletsBySection(body).flatMap((section) => section.items).map((item) => {
        const proposal = PROPOSAL.test(item.text);
        return { id: itemId('ask', file, item.text), proposal, ...splitRefs(item.text.replace(PROPOSAL, '')) };
      }),
    };
  }

  // What the companion knows about the person (user.md) and about the two of them (us.md): the bullets
  // of each `## 지금` / `## Now` section, the current answer. A file without one gives all its bullets.
  async function about(where) {
    const lines = [];
    for (const [file, kind] of [[where.user, 'user'], [where.us, 'us']]) {
      const body = await text(file);
      if (body === undefined) continue;
      const sections = bulletsBySection(body);
      const current = sections.filter((section) => /^(지금|now|current)$/i.test(section.title));
      const name = rel(where, file);
      const updatedAt = await lastChange(where, file);
      for (const section of current.length > 0 ? current : sections) {
        for (const item of section.items) lines.push({ id: itemId(kind, name, item.text), file: name, kind, updatedAt, ...splitRefs(item.text) });
      }
    }
    return lines;
  }

  async function records(where) {
    const days = new Map();
    for (const name of await list(where.memory)) {
      const match = DAY.exec(name);
      if (match) days.set(match[1], { date: match[1], daily: rel(where, path.join(where.memory, name)), diary: null, headline: '' });
    }
    for (const name of await list(where.diary)) {
      const match = DAY.exec(name);
      if (!match) continue;
      const day = days.get(match[1]) ?? { date: match[1], daily: null, diary: null, headline: '' };
      day.diary = rel(where, path.join(where.diary, name));
      days.set(match[1], day);
    }
    const sorted = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
    for (const day of sorted) {
      const source = day.daily ?? day.diary;
      day.headline = source ? dailyHeadline(await text(path.join(where.home, source))) : '';
    }
    const weekly = [];
    for (const name of await list(where.weekly)) {
      const match = WEEK.exec(name);
      if (!match) continue;
      const file = path.join(where.weekly, name);
      const body = await text(file);
      weekly.push({ week: match[1], path: rel(where, file), headline: firstSentence(body?.replace(/^#.*$/m, '') ?? '') });
    }
    weekly.sort((a, b) => b.week.localeCompare(a.week));
    return { days: sorted, weekly };
  }

  async function entities(where) {
    const found = [];
    for (const name of await list(where.entities)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(where.entities, name);
      const { fields } = frontMatter((await text(file)) ?? '');
      if (fields.type !== 'entity') continue;
      found.push({
        name: typeof fields.canonical === 'string' && fields.canonical ? fields.canonical : name.slice(0, -3),
        path: rel(where, file),
        summary: typeof fields.summary === 'string' ? fields.summary : null,
        aka: Array.isArray(fields.aka) ? fields.aka : [],
        tags: Array.isArray(fields.tags) ? fields.tags : [],
        updated: typeof fields.updated === 'string' ? fields.updated : null,
      });
    }
    return found.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')) || a.name.localeCompare(b.name));
  }

  async function dream(where) {
    let state;
    try { state = JSON.parse(await readFile(path.join(where.dream, 'state.json'), 'utf8')); }
    catch { return null; }
    let last = null;
    if (typeof state.lastRunId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,160}$/.test(state.lastRunId)) {
      try { last = JSON.parse(await readFile(path.join(where.dream, 'runs', state.lastRunId, 'run.json'), 'utf8')); }
      catch { last = null; }
    }
    return {
      lastRunAt: typeof state.lastRunAt === 'string' ? state.lastRunAt : null,
      lastStatus: typeof state.lastStatus === 'string' ? state.lastStatus : null,
      reason: typeof last?.reason === 'string' ? last.reason : null,
      attempts: Array.isArray(last?.attempts)
        ? last.attempts.map((attempt) => ({ model: String(attempt.model ?? ''), ok: attempt.ok === true, ...(attempt.error ? { error: String(attempt.error) } : {}) }))
        : [],
      // The last night it did each part of its work (distill, weekly, cleanup …).
      blocks: state.blocks && typeof state.blocks === 'object'
        ? Object.fromEntries(Object.entries(state.blocks).map(([name, block]) => [name, typeof block?.lastAt === 'string' ? block.lastAt : null]))
        : {},
    };
  }

  async function memory({ companionId }) {
    const where = await profile(companionId);
    const [statusBoard, asks, aboutLines, recorded, people, dreamState, sent] = await Promise.all([
      status(where), questions(where), about(where), records(where), entities(where), dream(where), readSent(),
    ]);
    const mine = sent[where.id] ?? {};
    const withSent = (item) => (mine[item.id] ? { ...item, sent: mine[item.id] } : item);
    return {
      id: where.id,
      title: where.title,
      home: where.home,
      exists: existsSync(where.memory),
      status: statusBoard && { ...statusBoard, sections: statusBoard.sections.map((section) => ({ ...section, items: section.items.map(withSent) })) },
      questions: asks && { ...asks, items: asks.items.map(withSent) },
      about: aboutLines.map(withSent),
      records: recorded.days,
      weekly: recorded.weekly,
      entities: people,
      dream: dreamState,
    };
  }

  // A path the page names: inside the companion's memory folder, a regular file, and still inside
  // the home once every link is resolved (memory/ref links repository documents in; those stay out).
  async function memoryFile(where, relative) {
    if (typeof relative !== 'string' || relative === '' || relative.includes('\0') || relative.includes('\\')) throw bad('File path is not valid.');
    const normal = path.posix.normalize(relative);
    if (normal !== relative || normal.startsWith('../') || path.posix.isAbsolute(normal) || !normal.endsWith('.md')) throw bad('File path is not valid.');
    const full = path.join(where.home, ...normal.split('/'));
    const memoryRoot = where.memory + path.sep;
    const diaryRoot = where.diary + path.sep;
    if (!full.startsWith(memoryRoot) && !full.startsWith(diaryRoot)) throw bad('Only the companion\'s memory can be read here.');
    let stat;
    try { stat = await lstat(full); } catch { throw new CompanionMemoryError(404, 'no-file', `No file ${normal}.`); }
    if (!stat.isFile()) throw bad('File path is not valid.');
    const [realHome, realFull] = await Promise.all([realpath(where.home), realpath(full)]);
    if (!realFull.startsWith(realHome + path.sep)) throw bad('File path is not valid.');
    return { full, relative: normal, size: stat.size };
  }

  async function file({ companionId, path: relative }) {
    const where = await profile(companionId);
    const found = await memoryFile(where, relative);
    const content = await readFile(found.full, 'utf8');
    return {
      path: found.relative,
      content: content.length > FILE_LIMIT ? content.slice(0, FILE_LIMIT) : content,
      truncated: content.length > FILE_LIMIT,
      updatedAt: await lastChange(where, found.full),
    };
  }

  // Every markdown file under the memory folder (and the diary, when it lives elsewhere); links are not followed.
  async function walk(where) {
    const found = [];
    const visit = async (dir, depth) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 4) await visit(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
      }
    };
    await visit(where.memory, 0);
    if (!where.diary.startsWith(where.memory + path.sep)) await visit(where.diary, 0);
    return found;
  }

  // Plain text over the companion's records, line by line: no index and no model, so it costs nothing.
  async function search({ companionId, query }) {
    if (typeof query !== 'string' || query.trim() === '' || query.length > 200) throw bad('Type something to search for.');
    const where = await profile(companionId);
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const full of await walk(where)) {
      const body = await text(full);
      if (body === undefined) continue;
      const lines = body.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line === '' || line === '---') continue;
        const lower = line.toLowerCase();
        if (!words.every((word) => lower.includes(word))) continue;
        results.push({ path: rel(where, full), line: index + 1, text: line.replace(/^[-*#>\s]+/, '').slice(0, 400) });
        if (results.length >= SEARCH_MAX) return { results, truncated: true };
      }
    }
    return { results, truncated: false };
  }

  // Commits in the home's history that touched its memory, newest first.
  async function changes({ companionId, since, limit }) {
    const where = await profile(companionId);
    if (!existsSync(path.join(where.home, '.git'))) return { changes: [] };
    const count = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), CHANGES_MAX) : 20;
    const args = ['log', `-n${count}`, '--name-only', '--format=%x1e%H%x1f%cI%x1f%s'];
    if (since !== undefined) {
      if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) throw bad('since must be a date.');
      args.push(`--since=${new Date(since).toISOString()}`);
    }
    args.push('--', rel(where, where.memory));
    const log = await git(where, args);
    if (log.code !== 0) return { changes: [] };
    return {
      changes: log.stdout.split('\x1e').slice(1).map((chunk) => {
        const [head, ...files] = chunk.split('\n');
        const [sha, at, subject] = head.split('\x1f');
        return { sha, at, subject, files: files.map((name) => name.trim()).filter(Boolean) };
      }),
    };
  }

  async function history({ companionId, path: relative }) {
    const where = await profile(companionId);
    const found = await memoryFile(where, relative);
    if (!existsSync(path.join(where.home, '.git'))) return { path: found.relative, commits: [] };
    const log = await git(where, ['log', '-n40', '--follow', '--format=%H%x1f%cI%x1f%s', '--', found.relative]);
    const commits = log.code !== 0 ? [] : log.stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, at, subject] = line.split('\x1f');
      return { sha, at, subject };
    });
    return { path: found.relative, commits };
  }

  async function diff({ companionId, path: relative, sha }) {
    const where = await profile(companionId);
    if (typeof sha !== 'string' || !SHA.test(sha)) throw bad('Commit is not valid.');
    const found = await memoryFile(where, relative).catch((error) => {
      // A file the commit deleted is not on disk any more; its history still is.
      if (error.code === 'no-file') return { relative };
      throw error;
    });
    if (typeof found.relative !== 'string' || !found.relative.endsWith('.md')) throw bad('File path is not valid.');
    const shown = await git(where, ['show', '--no-color', '--no-ext-diff', '--format=', '-M', sha, '--', found.relative]);
    if (shown.code !== 0) throw new CompanionMemoryError(404, 'no-commit', shown.stderr.trim() || 'That change is not in the history.');
    return { path: found.relative, sha, diff: shown.stdout.slice(0, 512 * 1024) };
  }

  // The person answered a question or asked the companion about a line: remembered so the page and the
  // room show it as sent until the companion takes the line out of its records.
  async function markSent({ companionId, itemId: id, at }) {
    const where = await profile(companionId);
    if (typeof id !== 'string' || !ITEM_ID.test(id)) throw bad('Item id is not valid.');
    const when = typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : new Date().toISOString();
    const sent = await readSent();
    const mine = { ...(sent[where.id] ?? {}), [id]: when };
    // Keep the newest 500 per companion; older marks belong to lines long gone.
    const kept = Object.fromEntries(Object.entries(mine).sort(([, a], [, b]) => String(b).localeCompare(String(a))).slice(0, 500));
    await mkdir(path.dirname(sentFile), { recursive: true });
    const temporary = `${sentFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...sent, [where.id]: kept }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, sentFile);
    return { companionId: where.id, itemId: id, sent: when };
  }

  return { companions, memory, file, search, changes, history, diff, markSent, profile, about };
}

/** git through execFile, for the service's default. */
export function execRun(argv, { cwd, env, timeoutMs = 30_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, env, timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
