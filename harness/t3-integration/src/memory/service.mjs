// The settings "기억" tab's server half. The T3 server loads this module from the
// Rubato checkout (next to bridge.mjs) and forwards one action per request; the
// page never names a path or a command, only a store, a run and the fields below.
//
// What it stands on is the dream contract, not the runner's internals:
//   rubato dream --json                  every store's switch and clock
//   rubato dream <store> --json          run now (minutes to tens of minutes: detached)
//   <memory>/agents/<store>/runtime/dream/runs/<runId>/{run.json,out/report.md,out/user-candidates.md}
//   <memory>/agents/<store>/repo                          the store's git repository
//   ~/.rubato/rubato.jsonc  memory.dream.{models,stores.<name>.enabled}
//   <project>/.rubato/rubato.jsonc  memory.agent       the store a project writes to
//   where.ts (bun)                                      which store each folder resolves to
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
const MODEL_ID = /^[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASONING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const LADDER_MAX = 8;
const PROJECTS_MAX = 200;
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
      // The CLI prints the stack of what failed; the page shows the sentence.
      const detail = (result.stderr || result.stdout).trim().split('\n')
        .filter((line) => !/^\s+at /.test(line))
        .map((line) => line.replace(/^rubato dream: (Error: )?/, ''))
        .slice(-6).join('\n');
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
  // The dream CLI resolves the ladder (the default included); rungs are {model, thinking?}.
  function ladderOf(cliStatus) {
    return (Array.isArray(cliStatus.models) ? cliStatus.models : [])
      .filter((rung) => typeof rung?.model === 'string')
      .map((rung) => ({ model: rung.model, reasoning: REASONING.has(rung.thinking) ? rung.thinking : null }));
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
    return { models: ladderOf(cliStatus), stores };
  }

  function summarize(runId, record) {
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
      landed: landed(record),
    };
  }

  // In the store now: merged at the end of the run (or approved, before dreams landed on their own)
  // and not reverted since.
  function landed(record) {
    if (record.review === 'reverted' || record.review === 'rejected') return false;
    return record.status === 'merged' || record.review === 'merged';
  }

  async function runRecords(paths) {
    let names = [];
    try { names = await readdir(paths.runs); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const records = [];
    for (const name of names) {
      if (!RUN_ID.test(name)) continue;
      const record = await readJson(path.join(paths.runs, name, 'run.json'));
      if (record) records.push([name, record]);
    }
    return records;
  }

  async function runs({ store }) {
    const paths = storePaths(assertStore(store));
    const items = (await runRecords(paths)).map(([name, record]) => summarize(name, record));
    items.sort((a, b) => String(b.startedAt ?? b.runId).localeCompare(String(a.startedAt ?? a.runId)));
    return { store, runs: items };
  }

  function rangeOf(record) {
    const commits = (Array.isArray(record.commits) ? record.commits : []).filter((sha) => SHA.test(sha));
    if (record.status === 'trial' && BRANCH.test(record.branch ?? '') && SHA.test(record.baseRevision ?? ''))
      return [record.baseRevision, record.branch];
    if (commits.length === 0) return null;
    const last = commits[commits.length - 1];
    if (SHA.test(record.baseRevision ?? '')) return [record.baseRevision, last];
    return [`${commits[0]}^`, last];
  }

  // Paths stay as written (no octal quoting) so they match the name list and the report.
  const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M'];

  async function diffOf(paths, range) {
    if (range === null) return { range: null, diff: '', diffNote: null };
    let from = range[0];
    let result = await git(paths.repo, [...DIFF, from, range[1], '--'], { maxBuffer: 64 * 1024 * 1024 });
    // The first commit of a store has no parent: diff it against the empty tree.
    if (result.code !== 0 && from.endsWith('^')) {
      from = EMPTY_TREE;
      result = await git(paths.repo, [...DIFF, from, range[1], '--'], { maxBuffer: 64 * 1024 * 1024 });
    }
    if (result.code !== 0) return { range: null, diff: '', diffNote: (result.stderr.trim() || 'git diff failed').split('\n')[0] };
    const truncated = result.stdout.length > DIFF_LIMIT;
    return { range: [from, range[1]], diff: truncated ? result.stdout.slice(0, DIFF_LIMIT) : result.stdout, diffNote: truncated ? 'truncated' : null };
  }

  // One card per file the run changed: what it is (its description), what the dream said about it
  // (the report lines naming it), and its own slice of the diff.
  async function changesOf(paths, range, diff, outline) {
    if (range === null) return [];
    const listed = await git(paths.repo, [...DIFF, '--name-status', range[0], range[1], '--']);
    if (listed.code !== 0) return [];
    const slices = splitDiff(diff);
    const changes = [];
    for (const line of listed.stdout.split('\n')) {
      const [status = '', first, second] = line.split('\t');
      if (!first) continue;
      const change = status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : status.startsWith('R') ? 'renamed' : 'modified';
      const file = change === 'renamed' && second ? second : first;
      let description = null;
      if (file.endsWith('.md') && changes.length < 200) {
        const shown = await git(paths.repo, ['show', `${change === 'deleted' ? range[0] : range[1]}:${file}`]);
        if (shown.code === 0) description = descriptionOf(shown.stdout);
      }
      const slice = slices.get(file) ?? '';
      changes.push({
        path: file,
        change,
        ...(change === 'renamed' ? { from: first } : {}),
        description,
        added: slice.split('\n').filter((row) => row.startsWith('+') && !row.startsWith('+++')).length,
        removed: slice.split('\n').filter((row) => row.startsWith('-') && !row.startsWith('---')).length,
        notes: notesFor(outline, change === 'renamed' ? [file, first] : [file]),
        diff: slice,
      });
    }
    return changes;
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
    const [report, candidates, { range, diff, diffNote }] = await Promise.all([
      readText(path.join(dir, 'out', 'report.md')),
      readText(path.join(dir, 'out', 'user-candidates.md')),
      diffOf(paths, rangeOf(record)),
    ]);
    const userText = (await readText(path.join(selfRepo, 'user.md'))) ?? '';
    const outline = reportOutline(report);
    return {
      store,
      ...summarize(runId, record),
      report: report ?? null,
      summary: outline.summary,
      changes: await changesOf(paths, range, diff, outline),
      diffNote,
      candidates: candidateLines(candidates).map((text) => ({ text, inUser: userText.includes(text) })),
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

  async function atomicWrite(file, content) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  function ladderInput(models) {
    if (!Array.isArray(models) || models.length === 0 || models.length > LADDER_MAX) throw bad(`The dream needs 1 to ${LADDER_MAX} models.`);
    const seen = new Set();
    return models.map((entry) => {
      const model = entry?.model;
      if (typeof model !== 'string' || !MODEL_ID.test(model)) throw bad('A model id is not valid.');
      if (seen.has(model)) throw bad(`${model} is listed twice.`);
      seen.add(model);
      if (entry.reasoning === undefined || entry.reasoning === null) return { model };
      if (!REASONING.has(entry.reasoning)) throw bad(`Reasoning for ${model} is not valid.`);
      return { model, reasoning: entry.reasoning };
    });
  }

  // A config file owns these keys. Each edit goes through jsonc `modify`, so
  // comments, other keys and their order stay as the user wrote them. An
  // undefined value removes the key.
  async function editJsonc(file, edits) {
    try { if ((await lstat(file)).isSymbolicLink()) throw new MemoryRequestError(409, 'config-symlink', `${file} is a symlink; edit it directly.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const text = (await readText(file)) ?? '';
    const errors = [];
    if (text.trim() !== '') jsonc.parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new MemoryRequestError(409, 'config-parse', `${file} does not parse. Fix it before saving here.`);
    let next = text.trim() === '' ? '{\n}\n' : text;
    for (const [keyPath, value] of edits) {
      next = jsonc.applyEdits(next, jsonc.modify(next, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
    }
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, next);
  }

  async function setConfig(input) {
    const edits = [];
    if (input.models !== undefined) edits.push([['memory', 'dream', 'models'], ladderInput(input.models)]);
    if (input.store !== undefined || input.enabled !== undefined) {
      assertStore(input.store);
      if (typeof input.enabled !== 'boolean') throw bad('Enabled must be true or false.');
      edits.push([['memory', 'dream', 'stores', input.store, 'enabled'], input.enabled]);
    }
    if (edits.length === 0) throw bad('Nothing to change.');
    await editJsonc(configPath(), edits);
    return { saved: edits.map(([keyPath, value]) => ({ key: keyPath.join('.'), value })) };
  }

  // --- Projects: which store each project folder writes to, and naming one.

  async function projectDir(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) throw bad('Project folder is not valid.');
    const { realpath, stat } = await import('node:fs/promises');
    let real;
    try { real = await realpath(dir); } catch { throw new MemoryRequestError(404, 'no-folder', `${dir} does not exist on this Mac.`); }
    if (!(await stat(real)).isDirectory()) throw bad('Project folder is not a directory.');
    return real;
  }

  async function projects({ dirs }) {
    if (!Array.isArray(dirs) || dirs.some((dir) => typeof dir !== 'string' || !path.isAbsolute(dir))) throw bad('Folders must be absolute paths.');
    const unique = [...new Set(dirs)].slice(0, PROJECTS_MAX);
    if (unique.length === 0) return { projects: [] };
    const result = await run(['bun', path.join(here, 'where.ts'), ...unique], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new MemoryRequestError(502, 'where-failed', (result.stderr || result.stdout).trim().split('\n').slice(-4).join('\n') || 'Could not resolve project stores.');
    try { return { projects: JSON.parse(result.stdout) }; }
    catch { throw new MemoryRequestError(502, 'where-output', 'where.ts did not print JSON.'); }
  }

  // Writes memory.agent into the project's own config; null clears it so the
  // folder goes back to the automatic store (its git repository, or none).
  async function setProjectStore({ dir, store }) {
    const real = await projectDir(dir);
    if (store !== null && (typeof store !== 'string' || !STORE_NAME.test(store) || store === 'auto')) throw bad('Store name is not valid.');
    const configDir = path.join(real, '.rubato');
    const jsoncFile = path.join(configDir, 'rubato.jsonc');
    const jsonFile = path.join(configDir, 'rubato.json');
    const file = !existsSync(jsoncFile) && existsSync(jsonFile) ? jsonFile : jsoncFile;
    if (store === null && !existsSync(file)) return { dir: real, store: null };
    await editJsonc(file, [[['memory', 'agent'], store === null ? undefined : store]]);
    return { dir: real, store };
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

  // --- Stores as the user sees them: which project each belongs to, what is in it.

  async function listStores() {
    let names = [];
    try { names = await readdir(path.join(memoryRoot, 'agents')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return names.filter((name) => STORE_NAME.test(name) && existsSync(path.join(storePaths(name).repo, '.git'))).sort();
  }

  // Everything in the store's working tree but git's own directory. Symlinks are
  // not followed: a store holds files the agent wrote, not links out of it.
  async function walk(repo, limit = 5000) {
    const found = [];
    const visit = async (relative) => {
      let entries;
      try { entries = await readdir(path.join(repo, relative), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (found.length >= limit) return;
        if (relative === '' && entry.name === '.git') continue;
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile()) found.push(child);
      }
    };
    await visit('');
    return found.sort();
  }

  async function storeSummary(store, config) {
    const paths = storePaths(store);
    const meta = await readJson(path.join(paths.root, 'store.json'));
    const roots = Array.isArray(meta?.roots) ? meta.roots.filter((root) => typeof root === 'string') : null;
    const [files, last, records, running] = await Promise.all([
      walk(paths.repo),
      git(paths.repo, ['log', '-1', '--format=%cI']),
      runRecords(paths),
      runningState(store),
    ]);
    const finished = records
      .filter(([, record]) => record.status !== 'busy' && record.status !== 'trial')
      .sort(([a, x], [b, y]) => String(y.startedAt ?? b).localeCompare(String(x.startedAt ?? a)))[0];
    return {
      store,
      roots,
      home: meta ? meta.home === true : null,
      files: files.length,
      lastChangeAt: last.code === 0 && last.stdout.trim() !== '' ? last.stdout.trim() : null,
      lastRun: finished ? lastRunOf(summarize(...finished)) : null,
      enabled: config.memory?.dream?.stores?.[store]?.enabled === true,
      running,
    };
  }

  function lastRunOf({ runId, status, startedAt, finishedAt, reason, landed: inStore }) {
    return { runId, status, startedAt, finishedAt, reason, landed: inStore };
  }

  /** Fast listing from the store directories; `status` adds what only the CLI knows. */
  async function stores() {
    const config = parseConfig((await readConfigText()).text);
    const list = await Promise.all((await listStores()).map((store) => storeSummary(store, config)));
    list.sort((a, b) => String(b.lastChangeAt ?? '').localeCompare(String(a.lastChangeAt ?? '')) || a.store.localeCompare(b.store));
    return { memoryRoot, stores: list };
  }

  function descriptionOf(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!match) return null;
    const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/.test(entry));
    if (!line) return null;
    const value = line.replace(/^description\s*:\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    return value === '' || value === '>' || value === '|' ? null : value;
  }

  async function files({ store }) {
    const paths = storePaths(assertStore(store));
    const list = await walk(paths.repo);
    const entries = await Promise.all(list.map(async (file) => {
      let description = null;
      if (file.endsWith('.md')) {
        const head = await readHead(path.join(paths.repo, file), 4096);
        description = descriptionOf(head);
      }
      return { path: file, description };
    }));
    return { store, files: entries, truncated: list.length >= 5000 };
  }

  async function readHead(file, bytes) {
    const { open } = await import('node:fs/promises');
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  }

  // A path the page names inside a store: relative, inside the working tree,
  // not git's directory, a regular file (not a link), and still inside after
  // resolving any linked parent directory.
  async function storeFile(store, relative) {
    const paths = storePaths(assertStore(store));
    if (typeof relative !== 'string' || relative === '' || relative.includes('\0') || relative.includes('\\')) throw bad('File path is not valid.');
    const normal = path.posix.normalize(relative);
    if (normal !== relative || path.posix.isAbsolute(normal) || normal.startsWith('../') || normal === '..' || normal === '.git' || normal.startsWith('.git/'))
      throw bad('File path is not valid.');
    const full = path.join(paths.repo, ...normal.split('/'));
    let stat;
    try { stat = await lstat(full); } catch { throw new MemoryRequestError(404, 'no-file', `No file ${normal} in ${store}.`); }
    if (!stat.isFile()) throw bad('File path is not valid.');
    const { realpath } = await import('node:fs/promises');
    const [realRepo, realFull] = await Promise.all([realpath(paths.repo), realpath(full)]);
    if (!realFull.startsWith(realRepo + path.sep)) throw bad('File path is not valid.');
    return { paths, relative: normal, full, size: stat.size };
  }

  async function readStoreFile({ store, path: relative }) {
    const file = await storeFile(store, relative);
    const limit = 1024 * 1024;
    const text = file.size > limit ? await readHead(file.full, limit) : await readFile(file.full, 'utf8');
    return { store, path: file.relative, content: text, truncated: file.size > limit };
  }

  async function identityArgs(repo) {
    return (await git(repo, ['config', 'user.email'])).stdout.trim() === ''
      ? ['-c', 'user.name=Rubato', '-c', 'user.email=rubato@localhost'] : [];
  }

  async function deleteStoreFile({ store, path: relative }) {
    const file = await storeFile(store, relative);
    const repo = file.paths.repo;
    const tracked = (await git(repo, ['ls-files', '--error-unmatch', '--', file.relative])).code === 0;
    if (!tracked) {
      await unlink(file.full);
      return { store, path: file.relative, commit: null };
    }
    const removed = await git(repo, ['rm', '-q', '--', file.relative]);
    if (removed.code !== 0) throw new MemoryRequestError(500, 'git-rm', removed.stderr.trim() || 'git rm failed.');
    // Only this path: whatever else an agent has staged stays out of this commit.
    const commit = await run(['git', '-C', repo, ...(await identityArgs(repo)), 'commit', '-q', '-m', `Delete ${file.relative} (Settings > Memory)`, '--', file.relative]);
    if (commit.code !== 0) throw new MemoryRequestError(500, 'git-commit', commit.stderr.trim() || 'git commit failed.');
    return { store, path: file.relative, commit: (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim() };
  }

  // An edit from the page commits that path alone, under the message the user typed.
  async function saveStoreFile({ store, path: relative, content, message }) {
    if (typeof content !== 'string' || content.length > 1024 * 1024) throw bad('Content must be text under 1 MB.');
    if (message !== undefined && typeof message !== 'string') throw bad('Message must be text.');
    const file = await storeFile(store, relative);
    const repo = file.paths.repo;
    await atomicWrite(file.full, content);
    const added = await git(repo, ['add', '--', file.relative]);
    if (added.code !== 0) throw new MemoryRequestError(500, 'git-add', added.stderr.trim() || 'git add failed.');
    if ((await git(repo, ['diff', '--cached', '--quiet', '--', file.relative])).code === 0) return { store, path: file.relative, content, commit: null };
    const subject = message?.trim().split('\n')[0].slice(0, 120) || `Edit ${file.relative} (Settings > Memory)`;
    // --no-verify: the person editing owns the file, frontmatter included; the agent-facing hook is not theirs.
    const commit = await run(['git', '-C', repo, ...(await identityArgs(repo)), 'commit', '-q', '--no-verify', '-m', subject, '--', file.relative]);
    if (commit.code !== 0) throw new MemoryRequestError(500, 'git-commit', commit.stderr.trim() || 'git commit failed.');
    return { store, path: file.relative, content, commit: (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim() };
  }

  // A whole store is archived, not erased: the archive is the undo.
  async function deleteStore({ store, confirm }) {
    const paths = storePaths(assertStore(store));
    if (confirm !== store) throw bad('Type the store name to confirm.');
    if (running.has(store) || (await runningState(store))) throw new MemoryRequestError(409, 'running', `A dream is running for ${store}. Try again when it ends.`);
    const backups = path.join(home, '.rubato', 'backups');
    await mkdir(backups, { recursive: true });
    const archive = path.join(backups, `${store}-${new Date().toISOString().replace(/[:.]/g, '-')}.tgz`);
    const agents = path.join(memoryRoot, 'agents');
    const packed = await run(['tar', '-czf', archive, '-C', agents, store], { timeoutMs: 300_000 });
    if (packed.code !== 0) {
      await unlink(archive).catch(() => undefined);
      throw new MemoryRequestError(500, 'archive', packed.stderr.trim() || 'Could not archive the store.');
    }
    const listed = await run(['tar', '-tzf', archive], { timeoutMs: 300_000, maxBuffer: 256 * 1024 * 1024 });
    if (listed.code !== 0 || !listed.stdout.split('\n').some((line) => line.replace(/\/$/, '') === `${store}/repo/.git`))
      throw new MemoryRequestError(500, 'archive', 'The archive could not be verified, so the store was kept.');
    const { rm } = await import('node:fs/promises');
    await rm(paths.root, { recursive: true, force: true });
    return { store, archive };
  }

  const actions = {
    status: () => status(),
    stores: () => stores(),
    files: (input) => files(input),
    file: (input) => readStoreFile(input),
    'save-file': (input) => saveStoreFile(input),
    'delete-file': (input) => deleteStoreFile(input),
    'delete-store': (input) => deleteStore(input),
    runs: (input) => runs(input),
    run: (input) => runDetail(input),
    dream: (input) => startDream(input),
    config: (input) => setConfig(input),
    projects: (input) => projects(input),
    'project-store': (input) => setProjectStore(input),
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

// --- The dream's report, read for the review cards. The headings are the ones dream-persona.md
// asks for; a report that does not follow them still shows in full, it just adds nothing to a card.

const NOTE_SECTIONS = [['바꾼 것', 'why'], ['코드와 어긋나 고친 것', 'code'], ['푼 모순', 'conflict']];

function reportOutline(report) {
  const sections = new Map();
  let current = null;
  for (const line of (report ?? '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
    } else if (current !== null) sections.get(current).push(line);
  }
  const bullets = (name) => (sections.get(name) ?? [])
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replaceAll('**', '').trim())
    .filter(Boolean);
  const summary = (sections.get('요약') ?? []).map((line) => line.trim()).filter(Boolean).join(' ');
  return { summary: summary || null, bullets };
}

function notesFor(outline, files) {
  const mentions = (line, file) => {
    if (line.includes(file)) return true;
    const base = file.slice(file.lastIndexOf('/') + 1);
    return base !== file && new RegExp(`(^|[\\s\`(])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(line);
  };
  const notes = [];
  for (const [section, kind] of NOTE_SECTIONS) {
    for (const line of outline.bullets(section)) {
      if (files.some((file) => mentions(line, file))) notes.push({ kind, text: noteText(line, kind) });
    }
  }
  return notes;
}

// "`decisions/x.md`: rewritten — why" → "why". The card already shows the file and how it changed.
function noteText(line, kind) {
  const colon = line.indexOf(': ');
  let text = colon > 0 && /[/.]/.test(line.slice(0, colon)) ? line.slice(colon + 2) : line;
  const dash = text.indexOf(' — ');
  if (kind === 'why' && dash > 0 && text.slice(0, dash).trim().split(/\s+/).length <= 4) text = text.slice(dash + 3);
  return text.trim();
}

function splitDiff(diff) {
  const slices = new Map();
  let file = null;
  let rows = [];
  const flush = () => { if (file !== null) slices.set(file, rows.join('\n')); };
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      flush();
      file = row.slice(row.lastIndexOf(' b/') + 3);
      rows = [row];
    } else if (file !== null) rows.push(row);
  }
  flush();
  return slices;
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
