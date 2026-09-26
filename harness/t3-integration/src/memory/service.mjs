// The settings "기억" tab's server half. The T3 server loads this module from the
// Rubato checkout (next to bridge.mjs) and forwards one action per request; the
// page never names a path or a command, only a store, a run and the fields below.
//
// What it stands on is the dream contract, not the runner's internals:
//   rubato dream --json                  every store's switch, clock and review marker
//   rubato dream <store> --json          run now (minutes to tens of minutes: detached)
//   rubato dream --approve|--reject <store> --json
//   <memory>/agents/<store>/runtime/dream/runs/<runId>/{run.json,out/report.md,out/user-candidates.md}
//   <memory>/agents/<store>/runtime/dream/pending.json   {runId, branch, baseRevision}
//   <memory>/agents/<store>/repo                          the store's git repository
//   ~/.rubato/rubato.jsonc  memory.dream.{category,publish,stores.<name>.enabled}
//   <memory>/self/repo/{user.md,soul.md}                  every save is a commit
import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
// The config writer's own dependency: comment-preserving `modify`. Resolved from
// the package that owns it so a hoisting change does not strand this module.
const jsonc = createRequire(path.join(repoRoot, 'packages', 'rubato-config-core', 'package.json'))('jsonc-parser');

const STORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{7,64}$/;
const BRANCH = /^dream\/[A-Za-z0-9._-]+$/;
const SELF_FILES = new Set(['user.md', 'soul.md']);
const DIFF_LIMIT = 512 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class MemoryRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message) => new MemoryRequestError(400, 'bad-request', message);

/**
 * @param {{ env?: NodeJS.ProcessEnv, rubato?: readonly string[] }} [options]
 *   `rubato` is the argv prefix that runs the CLI; default: this checkout's launcher.
 */
export function createMemoryService(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const memoryRoot = env.RUBATO_MEMORY_HOME?.trim() ? path.resolve(home, env.RUBATO_MEMORY_HOME) : path.join(home, '.rubato', 'memory');
  const rubato = options.rubato ?? ['/bin/sh', path.join(repoRoot, 'harness', 'scripts', 'rubato-pi.sh')];
  // The app is often launched from the Dock with a PATH of /usr/bin:/bin, and
  // `rubato dream` execs bun from PATH. Put the usual install places first.
  const childEnv = { ...env, PATH: [
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'share', 'vite-plus', 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin',
  ].join(path.delimiter) };
  const running = new Map();

  const storePaths = (store) => {
    const root = path.join(memoryRoot, 'agents', store);
    const dream = path.join(root, 'runtime', 'dream');
    return { root, repo: path.join(root, 'repo'), dream, runs: path.join(dream, 'runs'), gui: path.join(dream, 'gui') };
  };
  const selfRepo = path.join(memoryRoot, 'self', 'repo');
  const configPath = () => {
    const jsoncPath = path.join(home, '.rubato', 'rubato.jsonc');
    const jsonPath = path.join(home, '.rubato', 'rubato.json');
    return !existsSync(jsoncPath) && existsSync(jsonPath) ? jsonPath : jsoncPath;
  };

  function run(argv, { cwd, timeoutMs = 120_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
      execFile(argv[0], argv.slice(1), { cwd, env: childEnv, timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error });
      });
    });
  }
  const git = (cwd, args, options) => run(['git', '-C', cwd, ...args], options);
  async function cli(args, timeoutMs) {
    const result = await run([...rubato, 'dream', ...args], { timeoutMs });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n');
      throw new MemoryRequestError(502, 'dream-cli-failed', detail || `rubato dream exited with code ${result.code}.`);
    }
    try { return JSON.parse(result.stdout); }
    catch { throw new MemoryRequestError(502, 'dream-cli-output', 'rubato dream --json did not print JSON.'); }
  }

  // A store is what the CLI would list: a directory under agents/ holding a git repo.
  function assertStore(store) {
    if (typeof store !== 'string' || !STORE_NAME.test(store)) throw bad('Store name is not valid.');
    if (!existsSync(path.join(storePaths(store).repo, '.git'))) throw new MemoryRequestError(404, 'no-store', `No memory store named ${store}.`);
    return store;
  }
  function assertRunId(runId) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw bad('Run id is not valid.');
    return runId;
  }

  async function readJson(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
  }
  async function readText(file) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }

  async function readConfigText() {
    const file = configPath();
    return { file, text: (await readText(file)) ?? '' };
  }
  function parseConfig(text) {
    const errors = [];
    const value = jsonc.parse(text, errors, { allowTrailingComma: true });
    return value && typeof value === 'object' ? value : {};
  }
  function categoriesOf(config) {
    const merged = { ...(config['[senpi]']?.categories ?? {}), ...(config.categories ?? {}) };
    return Object.entries(merged)
      .filter(([, entry]) => entry && typeof entry === 'object')
      .map(([name, entry]) => ({
        name,
        models: [entry.model, ...(Array.isArray(entry.models) ? entry.models : [])]
          .map((item) => (typeof item === 'string' ? item : item?.model))
          .filter((model, index, all) => typeof model === 'string' && model.includes('/') && all.indexOf(model) === index),
      }))
      .filter((entry) => entry.models.length > 0);
  }

  function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
  }
  // A dream started here is tracked by its marker; one started elsewhere (the
  // daily --due run) holds the store's dream lock.
  async function runningState(store) {
    const paths = storePaths(store);
    const marker = await readJson(path.join(paths.gui, 'running.json'));
    if (marker && alive(marker.pid)) return { startedAt: marker.startedAt, source: 'gui' };
    const lock = await readJson(path.join(paths.root, 'runtime', 'locks', 'dream.lock'));
    if (lock && alive(lock.pid)) return { startedAt: lock.created_at, source: 'other' };
    return null;
  }
  async function lastGuiRun(store) {
    const paths = storePaths(store);
    const marker = await readJson(path.join(paths.gui, 'running.json'));
    if (!marker || alive(marker.pid)) return null;
    const output = await readJson(path.join(paths.gui, 'last.out.json'));
    const record = Array.isArray(output?.runs) ? output.runs[0] : undefined;
    if (record) return { startedAt: marker.startedAt, status: record.status, runId: record.runId || undefined, reason: record.reason };
    const log = (await readText(path.join(paths.gui, 'last.log'))) ?? '';
    return { startedAt: marker.startedAt, status: 'failed', reason: log.trim().split('\n').slice(-4).join('\n') || 'The run ended without output.' };
  }

  async function status() {
    const [cliStatus, { text }] = await Promise.all([cli(['--json'], 120_000), readConfigText()]);
    const config = parseConfig(text);
    const dream = config.memory?.dream ?? {};
    const stores = await Promise.all((cliStatus.stores ?? []).map(async (entry) => ({
      ...entry,
      running: STORE_NAME.test(entry.store) ? await runningState(entry.store) : null,
      lastGuiRun: STORE_NAME.test(entry.store) ? await lastGuiRun(entry.store) : null,
    })));
    return {
      category: cliStatus.category,
      publish: dream.publish === 'auto' ? 'auto' : 'review',
      categories: categoriesOf(config),
      stores,
    };
  }

  function summarize(runId, record, pending) {
    return {
      runId,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      model: record.model,
      reason: record.reason,
      review: record.review,
      reviewedAt: record.reviewedAt,
      sessions: Array.isArray(record.sessions) ? record.sessions.length : 0,
      commits: Array.isArray(record.commits) ? record.commits.length : 0,
      pending: pending?.runId === runId,
    };
  }

  async function runs({ store }) {
    const paths = storePaths(assertStore(store));
    const pending = await readJson(path.join(paths.dream, 'pending.json'));
    let names = [];
    try { names = await readdir(paths.runs); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const items = [];
    for (const name of names) {
      if (!RUN_ID.test(name)) continue;
      const record = await readJson(path.join(paths.runs, name, 'run.json'));
      if (record) items.push(summarize(name, record, pending));
    }
    items.sort((a, b) => String(b.startedAt ?? b.runId).localeCompare(String(a.startedAt ?? a.runId)));
    return { store, pendingRunId: pending?.runId ?? null, runs: items };
  }

  async function diffOf(paths, runId, record, pending) {
    const range = (() => {
      if (pending?.runId === runId && BRANCH.test(pending.branch ?? '') && SHA.test(pending.baseRevision ?? ''))
        return [pending.baseRevision, pending.branch];
      const commits = (Array.isArray(record.commits) ? record.commits : []).filter((sha) => SHA.test(sha));
      if (record.status === 'trial' && BRANCH.test(record.branch ?? '') && SHA.test(record.baseRevision ?? ''))
        return [record.baseRevision, record.branch];
      if (commits.length === 0) return null;
      const last = commits[commits.length - 1];
      if (SHA.test(record.baseRevision ?? '')) return [record.baseRevision, last];
      return [`${commits[0]}^`, last];
    })();
    if (range === null) return { diff: '', diffNote: null };
    let result = await git(paths.repo, ['diff', '--no-color', '--no-ext-diff', range[0], range[1], '--'], { maxBuffer: 64 * 1024 * 1024 });
    // The first commit of a store has no parent: diff it against the empty tree.
    if (result.code !== 0 && range[0].endsWith('^'))
      result = await git(paths.repo, ['diff', '--no-color', '--no-ext-diff', EMPTY_TREE, range[1], '--'], { maxBuffer: 64 * 1024 * 1024 });
    if (result.code !== 0) return { diff: '', diffNote: (result.stderr.trim() || 'git diff failed').split('\n')[0] };
    const truncated = result.stdout.length > DIFF_LIMIT;
    return { diff: truncated ? result.stdout.slice(0, DIFF_LIMIT) : result.stdout, diffNote: truncated ? 'truncated' : null };
  }

  function candidateLines(text) {
    if (!text) return [];
    return text.split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter((line) => line !== '');
  }

  async function runDetail({ store, runId }) {
    const paths = storePaths(assertStore(store));
    assertRunId(runId);
    const dir = path.join(paths.runs, runId);
    const record = await readJson(path.join(dir, 'run.json'));
    if (!record) throw new MemoryRequestError(404, 'no-run', `No dream run ${runId} in ${store}.`);
    const pending = await readJson(path.join(paths.dream, 'pending.json'));
    const [report, candidates, diff] = await Promise.all([
      readText(path.join(dir, 'out', 'report.md')),
      readText(path.join(dir, 'out', 'user-candidates.md')),
      diffOf(paths, runId, record, pending),
    ]);
    const userText = (await readText(path.join(selfRepo, 'user.md'))) ?? '';
    return {
      store,
      ...summarize(runId, record, pending),
      sessionList: (Array.isArray(record.sessions) ? record.sessions : []).map((session) => ({
        id: session.id, name: session.name, cwd: session.cwd, messages: session.messages,
      })),
      report: report ?? null,
      candidates: candidateLines(candidates).map((text) => ({ text, inUser: userText.includes(text) })),
      ...diff,
    };
  }

  async function startDream({ store }) {
    const paths = storePaths(assertStore(store));
    if (running.has(store) || (await runningState(store))) throw new MemoryRequestError(409, 'running', `A dream is already running for ${store}.`);
    await mkdir(paths.gui, { recursive: true });
    const out = openSync(path.join(paths.gui, 'last.out.json'), 'w');
    const err = openSync(path.join(paths.gui, 'last.log'), 'w');
    let child;
    try {
      // Detached into its own group: closing the app must not end a dream mid-edit.
      child = spawn(rubato[0], [...rubato.slice(1), 'dream', store, '--json'], {
        cwd: home, env: childEnv, detached: true, stdio: ['ignore', out, err],
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    const startedAt = new Date().toISOString();
    await atomicWrite(path.join(paths.gui, 'running.json'), `${JSON.stringify({ pid: child.pid, startedAt }, null, 2)}\n`);
    running.set(store, child);
    child.once('exit', () => running.delete(store));
    child.once('error', () => running.delete(store));
    child.unref();
    return { store, startedAt };
  }

  async function review({ store, decision }) {
    assertStore(store);
    if (decision !== 'approve' && decision !== 'reject') throw bad('Decision must be approve or reject.');
    return cli([decision === 'approve' ? '--approve' : '--reject', store, '--json'], 180_000);
  }

  async function atomicWrite(file, content) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  // The user file owns these keys. Each edit goes through jsonc `modify`, so
  // comments, other keys and their order stay as the user wrote them.
  async function setConfig(input) {
    const edits = [];
    if (input.category !== undefined) {
      if (typeof input.category !== 'string' || !CATEGORY.test(input.category)) throw bad('Category is not valid.');
      edits.push([['memory', 'dream', 'category'], input.category]);
    }
    if (input.publish !== undefined) {
      if (input.publish !== 'review' && input.publish !== 'auto') throw bad('Publish must be review or auto.');
      edits.push([['memory', 'dream', 'publish'], input.publish]);
    }
    if (input.store !== undefined || input.enabled !== undefined) {
      assertStore(input.store);
      if (typeof input.enabled !== 'boolean') throw bad('Enabled must be true or false.');
      edits.push([['memory', 'dream', 'stores', input.store, 'enabled'], input.enabled]);
    }
    if (edits.length === 0) throw bad('Nothing to change.');
    const { file, text } = await readConfigText();
    try { if ((await lstat(file)).isSymbolicLink()) throw new MemoryRequestError(409, 'config-symlink', 'rubato.jsonc is a symlink; edit it directly.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const errors = [];
    jsonc.parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new MemoryRequestError(409, 'config-parse', `${file} does not parse. Fix it before saving here.`);
    let next = text.trim() === '' ? '{\n}\n' : text;
    for (const [keyPath, value] of edits) {
      next = jsonc.applyEdits(next, jsonc.modify(next, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
    }
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, next);
    return { saved: edits.map(([keyPath, value]) => ({ key: keyPath.join('.'), value })) };
  }

  async function ensureSelfRepo() {
    await mkdir(selfRepo, { recursive: true });
    if (existsSync(path.join(selfRepo, '.git'))) return;
    const init = await git(selfRepo, ['init', '-q']);
    if (init.code !== 0) throw new MemoryRequestError(500, 'git-init', init.stderr.trim() || 'git init failed.');
  }
  async function commitSelf(file, message) {
    const add = await git(selfRepo, ['add', '--', file]);
    if (add.code !== 0) throw new MemoryRequestError(500, 'git-add', add.stderr.trim() || 'git add failed.');
    const staged = await git(selfRepo, ['diff', '--cached', '--quiet', '--', file]);
    if (staged.code === 0) return null;
    // Commit as the user's git identity when there is one; a fresh machine may have none.
    const identity = (await git(selfRepo, ['config', 'user.email'])).stdout.trim() === ''
      ? ['-c', 'user.name=Rubato', '-c', 'user.email=rubato@localhost'] : [];
    const commit = await run(['git', '-C', selfRepo, ...identity, 'commit', '-q', '-m', message, '--', file]);
    if (commit.code !== 0) throw new MemoryRequestError(500, 'git-commit', commit.stderr.trim() || 'git commit failed.');
    return (await git(selfRepo, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  function lineDelta(before, after) {
    const count = (text) => { const map = new Map(); for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1); return map; };
    const a = count(before);
    const b = count(after);
    let added = 0;
    let removed = 0;
    for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
    for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
    return `+${added} -${removed}`;
  }

  async function readSelf() {
    const [user, soul] = await Promise.all([readText(path.join(selfRepo, 'user.md')), readText(path.join(selfRepo, 'soul.md'))]);
    return { user: user ?? '', soul: soul ?? '', repo: existsSync(path.join(selfRepo, '.git')) };
  }

  async function saveSelf({ file, content, summary }) {
    if (!SELF_FILES.has(file)) throw bad('File must be user.md or soul.md.');
    if (typeof content !== 'string' || content.length > 1024 * 1024) throw bad('Content must be text under 1 MB.');
    if (summary !== undefined && typeof summary !== 'string') throw bad('Summary must be text.');
    await ensureSelfRepo();
    const target = path.join(selfRepo, file);
    const before = (await readText(target)) ?? '';
    const text = content === '' || content.endsWith('\n') ? content : `${content}\n`;
    await atomicWrite(target, text);
    const note = summary?.trim().split('\n')[0].slice(0, 120) || `edit in settings (${lineDelta(before, text)})`;
    return { file, commit: await commitSelf(file, `${file}: ${note}`) };
  }

  async function addCandidates({ store, runId, lines }) {
    const detail = await runDetail({ store, runId });
    if (!Array.isArray(lines) || lines.length === 0 || lines.some((line) => typeof line !== 'string')) throw bad('Choose at least one line.');
    const offered = new Set(detail.candidates.map((candidate) => candidate.text));
    const unknown = lines.filter((line) => !offered.has(line));
    if (unknown.length > 0) throw bad('A chosen line is not in this run\'s candidates.');
    await ensureSelfRepo();
    const target = path.join(selfRepo, 'user.md');
    const before = (await readText(target)) ?? '';
    const fresh = [...new Set(lines)].filter((line) => !before.includes(line));
    if (fresh.length === 0) return { file: 'user.md', added: 0, commit: null };
    const base = before === '' || before.endsWith('\n') ? before : `${before}\n`;
    await atomicWrite(target, `${base}${fresh.map((line) => `- ${line}`).join('\n')}\n`);
    const commit = await commitSelf('user.md', `user.md: add ${fresh.length} dream candidate${fresh.length === 1 ? '' : 's'} from ${store} ${runId}`);
    return { file: 'user.md', added: fresh.length, commit };
  }

  const actions = {
    status: () => status(),
    runs: (input) => runs(input),
    run: (input) => runDetail(input),
    dream: (input) => startDream(input),
    review: (input) => review(input),
    config: (input) => setConfig(input),
    self: () => readSelf(),
    'self-save': (input) => saveSelf(input),
    'add-candidates': (input) => addCandidates(input),
  };
  return {
    actions: Object.keys(actions),
    async handle(action, input) {
      const handler = Object.hasOwn(actions, action) ? actions[action] : undefined;
      if (!handler) throw new MemoryRequestError(404, 'no-action', `Unknown memory action ${action}.`);
      return handler(input && typeof input === 'object' ? input : {});
    },
  };
}

/** One HTTP exchange: `/rubato/memory/<action>`, JSON in (POST) and JSON out. */
export async function handleMemoryRequest(service, request) {
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  let input = {};
  if (request.method === 'POST') {
    try { input = await request.json(); } catch { return Response.json({ error: { code: 'bad-request', message: 'Request body must be JSON.' } }, { status: 400 }); }
  } else if (request.method !== 'GET') {
    return Response.json({ error: { code: 'method', message: 'Use GET or POST.' } }, { status: 405 });
  }
  try {
    return Response.json(await service.handle(action, input));
  } catch (error) {
    const status = error instanceof MemoryRequestError ? error.status : 500;
    const code = error instanceof MemoryRequestError ? error.code : 'failed';
    return Response.json({ error: { code, message: error instanceof Error ? error.message : String(error) } }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function memoryService() {
  shared ??= createMemoryService();
  return shared;
}
