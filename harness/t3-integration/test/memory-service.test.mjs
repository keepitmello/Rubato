// The Memory tab's server half against the real `rubato dream` CLI, on a throwaway
// HOME: a store with a dream waiting for review, approved and rejected through
// the CLI, plus the config and self-store writes the tab makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryService, handleMemoryRequest } from '../src/memory/service.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
const bunAvailable = (() => { try { execFileSync('bun', ['--version']); return true; } catch { return false; } })();

const CONFIG = `{
  // 사용자 주석은 남아야 한다
  "memory": {
    "dream": {
      "models": [{ "model": "b-ai/deepseek-v4.1-flash", "reasoning": "medium" }, "xai/grok-4.7"], // 꼬리 주석
      "stores": { "scratch": { "enabled": true } }
    }
  },
  "_migrations": ["2026-08-reasoning-unification"]
}
`;

function jsoncModels(text) {
  // The fixture's comments must survive; strip them only to read the value back.
  const stripped = text.replace(/\/\/[^\n]*/g, '');
  return JSON.parse(stripped).memory.dream.models;
}

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-memory-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.rubato'), { recursive: true });
  await writeFile(path.join(home, '.rubato', 'rubato.jsonc'), CONFIG);
  const store = path.join(home, '.rubato', 'memory', 'agents', 'scratch');
  const repo = path.join(store, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'notes.md'), 'first\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const service = createMemoryService({ env: { ...process.env, HOME: home, RUBATO_MEMORY_HOME: '' } });
  return { home, store, repo, service };
}

// What the runner leaves for a dream under publish "review": a branch, a marker, a run record.
async function pendingDream({ store, repo }, runId, line, report = `## 요약\n\n${line}\n`) {
  const base = git(repo, 'rev-parse', 'HEAD');
  const branch = `dream/${runId}`;
  git(repo, 'branch', branch, base);
  const work = path.join(store, 'runtime', 'worktrees', runId);
  git(repo, 'worktree', 'add', '-q', work, branch);
  await writeFile(path.join(work, 'notes.md'), `first\n${line}\n`);
  git(work, 'commit', '-q', '-am', `dream: ${line}`);
  const commit = git(work, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'remove', '--force', work);
  const dir = path.join(store, 'runtime', 'dream', 'runs', runId);
  await mkdir(path.join(dir, 'out'), { recursive: true });
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({
    runId, store: 'scratch', startedAt: '2026-09-26T01:00:00.000Z', finishedAt: '2026-09-26T01:10:00.000Z',
    status: 'pending', model: 'b-ai/deepseek-v4.1-flash',
    sessions: [{ id: 's1', cwd: '/tmp', messages: 3 }], commits: [commit], branch, baseRevision: base,
  }));
  await writeFile(path.join(dir, 'out', 'report.md'), report);
  await writeFile(path.join(dir, 'out', 'user-candidates.md'), '# user-candidates\n\n- 한국어 반말을 좋아한다\n- base 에 바로 푸시한다\n');
  await writeFile(path.join(store, 'runtime', 'dream', 'pending.json'), JSON.stringify({ runId, branch, baseRevision: base }));
  return { branch, base, commit };
}

test('status, review and diffs go through the real dream CLI', { skip: !bunAvailable && 'bun is not installed' }, async (t) => {
  const f = await fixture(t);
  await pendingDream(f, 'dream-a', 'second');

  const status = await f.service.handle('status', {});
  assert.deepEqual(status.models, [
    { model: 'b-ai/deepseek-v4.1-flash', reasoning: 'medium' },
    { model: 'xai/grok-4.7', reasoning: null },
  ]);
  assert.equal(status.publish, 'review');
  const scratch = status.stores.find((entry) => entry.store === 'scratch');
  assert.equal(scratch.enabled, true);
  assert.equal(scratch.pendingRunId, 'dream-a');
  assert.equal(scratch.running, null);

  const listed = await f.service.handle('runs', { store: 'scratch' });
  assert.deepEqual(listed.runs.map((run) => [run.runId, run.status, run.pending, run.sessions]), [['dream-a', 'pending', true, 1]]);

  const detail = await f.service.handle('run', { store: 'scratch', runId: 'dream-a' });
  assert.match(detail.report, /second/);
  assert.match(detail.changes[0].diff, /^\+second$/m);
  assert.deepEqual(detail.candidates.map((c) => c.text), ['한국어 반말을 좋아한다', 'base 에 바로 푸시한다']);

  const approved = await f.service.handle('review', { store: 'scratch', decision: 'approve' });
  assert.equal(approved.review, 'merged');
  assert.equal(await readFile(path.join(f.repo, 'notes.md'), 'utf8'), 'first\nsecond\n');
  const merged = await f.service.handle('run', { store: 'scratch', runId: 'dream-a' });
  assert.equal(merged.review, 'merged');
  assert.equal(merged.pending, false);
  assert.match(merged.changes[0].diff, /^\+second$/m, 'a merged run still shows what it changed');

  await pendingDream(f, 'dream-b', 'third');
  const rejected = await f.service.handle('review', { store: 'scratch', decision: 'reject' });
  assert.equal(rejected.review, 'rejected');
  assert.equal(await readFile(path.join(f.repo, 'notes.md'), 'utf8'), 'first\nsecond\n');
  assert.equal((await f.service.handle('status', {})).stores.find((entry) => entry.store === 'scratch').pendingRunId, undefined);

  await assert.rejects(f.service.handle('review', { store: 'scratch', decision: 'approve' }), /waiting for review/);
  await assert.rejects(f.service.handle('runs', { store: '../scratch' }), /not valid/);
  await assert.rejects(f.service.handle('run', { store: 'scratch', runId: '../../x' }), /not valid/);
  await assert.rejects(f.service.handle('runs', { store: 'ghost' }), /No memory store/);
});

test('a run reads as one card per changed file, and the store says what needs the user', { skip: !bunAvailable && 'bun is not installed' }, async (t) => {
  const f = await fixture(t);
  const report = [
    '## 요약', '노트 한 줄을 더했다.',
    '## 바꾼 것', '- `notes.md`: rewritten — 두 번째 줄이 빠져 있었다',
    '## 푼 모순', '- `notes.md` vs `other.md`: kept notes.md, because 최신',
    '## 남긴 것', '- 상태 서술: git 이 이미 안다', '  - 들여쓴 줄은 따로 세지 않는다', '',
  ].join('\n');
  const { base } = await pendingDream(f, 'dream-a', 'second', report);
  const inbox = async () => (await f.service.handle('stores', {})).stores.find((s) => s.store === 'scratch').inbox;

  const detail = await f.service.handle('run', { store: 'scratch', runId: 'dream-a' });
  assert.equal(detail.summary, '노트 한 줄을 더했다.');
  assert.deepEqual(detail.skipped, ['상태 서술: git 이 이미 안다']);
  assert.deepEqual(detail.changes.map(({ diff, ...card }) => card), [{
    path: 'notes.md', change: 'modified', description: null, added: 1, removed: 0,
    notes: [{ kind: 'why', text: '두 번째 줄이 빠져 있었다' }, { kind: 'conflict', text: 'kept notes.md, because 최신' }],
  }]);
  assert.equal(detail.sources.range.base, base);
  assert.match(detail.sources.report, /dream-a\/out\/report\.md$/);
  assert.deepEqual(await inbox(), { runId: 'dream-a', kind: 'pending' });
  assert.deepEqual(detail.uncommitted, []);

  // A session that wrote to the store and stopped blocks the merge; the page learns which file first,
  // and the refusal reads as a sentence, not a stack.
  await writeFile(path.join(f.repo, 'notes.md'), 'first\nleft by a session\n');
  assert.deepEqual((await f.service.handle('run', { store: 'scratch', runId: 'dream-a' })).uncommitted, ['notes.md']);
  await assert.rejects(f.service.handle('review', { store: 'scratch', decision: 'approve' }), (error) => {
    assert.match(error.message, /^store has uncommitted changes; the branch dream\/dream-a is still waiting$/);
    return true;
  });
  git(f.repo, 'checkout', '--', 'notes.md');

  // Approving here counts as having looked at it.
  await f.service.handle('review', { store: 'scratch', decision: 'approve' });
  assert.equal(await inbox(), null);
  assert.equal((await f.service.handle('runs', { store: 'scratch' })).runs[0].landed, true);

  const reverted = await f.service.handle('revert', { store: 'scratch', runId: 'dream-a' });
  assert.equal(reverted.review, 'reverted');
  assert.equal(await readFile(path.join(f.repo, 'notes.md'), 'utf8'), 'first\n');
  assert.equal((await f.service.handle('run', { store: 'scratch', runId: 'dream-a' })).landed, false);
  await assert.rejects(f.service.handle('revert', { store: 'scratch', runId: 'dream-a' }), /already reverted/);

  // An approved run was looked at, and undoing the newest does not bring an older one back as news.
  await pendingDream(f, 'dream-b', 'third');
  await f.service.handle('review', { store: 'scratch', decision: 'approve' });
  assert.equal(await inbox(), null);

  // A dream that landed on its own (publish "auto") after the user last looked is news until acknowledged.
  const record = path.join(f.store, 'runtime', 'dream', 'runs', 'dream-b', 'run.json');
  const { review: _review, ...run } = JSON.parse(await readFile(record, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(record, JSON.stringify({ ...run, status: 'merged', finishedAt: new Date().toISOString() }));
  assert.deepEqual(await inbox(), { runId: 'dream-b', kind: 'landed' });
  await f.service.handle('ack', { store: 'scratch', runId: 'dream-b' });
  assert.equal(await inbox(), null);

  // The first look only sets the mark: what landed before the page existed is not news.
  await rm(path.join(f.store, 'runtime', 'dream', 'gui', 'seen.json'));
  assert.equal(await inbox(), null);
  assert.equal(JSON.parse(await readFile(path.join(f.store, 'runtime', 'dream', 'gui', 'seen.json'), 'utf8')).runId, 'dream-b');
  await assert.rejects(f.service.handle('ack', { store: 'scratch', runId: '../x' }), /not valid/);
});

test('run now is detached and its result is read back', { skip: !bunAvailable && 'bun is not installed' }, async (t) => {
  const f = await fixture(t);
  // This HOME has no auth and the run has no sessions: the CLI ends on its own quickly.
  const started = await f.service.handle('dream', { store: 'scratch' });
  assert.equal(typeof started.startedAt, 'string');
  await assert.rejects(f.service.handle('dream', { store: 'scratch' }), /already running/);
  let last;
  for (let i = 0; i < 120; i += 1) {
    const entry = (await f.service.handle('status', {})).stores.find((s) => s.store === 'scratch');
    if (entry.running === null && entry.lastGuiRun) { last = entry.lastGuiRun; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(last, 'the run finished and left a result');
  assert.ok(['failed', 'noop', 'busy', 'merged', 'pending'].includes(last.status), JSON.stringify(last));
});

test('settings writes keep the user file and commit the self store', async (t) => {
  const f = await fixture(t);
  const configFile = path.join(f.home, '.rubato', 'rubato.jsonc');
  await f.service.handle('config', { publish: 'auto' });
  await f.service.handle('config', { models: [{ model: 'xai/grok-4.7', reasoning: 'high' }, { model: 'anthropic/claude-haiku-4-5' }] });
  await f.service.handle('config', { store: 'scratch', enabled: false });
  const text = await readFile(configFile, 'utf8');
  assert.match(text, /\/\/ 사용자 주석은 남아야 한다/);
  assert.match(text, /\/\/ 꼬리 주석/);
  assert.match(text, /"publish": "auto"/);
  assert.deepEqual(jsoncModels(text), [{ model: 'xai/grok-4.7', reasoning: 'high' }, { model: 'anthropic/claude-haiku-4-5' }]);
  assert.match(text, /"scratch": \{ "enabled": false \}|"scratch": \{\s*"enabled": false\s*\}/);
  assert.match(text, /"_migrations": \["2026-08-reasoning-unification"\]/);
  await assert.rejects(f.service.handle('config', { publish: 'sometimes' }), /review or auto/);
  await assert.rejects(f.service.handle('config', { models: [] }), /1 to 8 models/);
  await assert.rejects(f.service.handle('config', { models: [{ model: 'grok' }] }), /not valid/);
  await assert.rejects(f.service.handle('config', { models: [{ model: 'xai/grok-4.7' }, { model: 'xai/grok-4.7' }] }), /twice/);
  await assert.rejects(f.service.handle('config', { models: [{ model: 'xai/grok-4.7', reasoning: 'huge' }] }), /Reasoning/);
  await assert.rejects(f.service.handle('config', { store: 'ghost', enabled: true }), /No memory store/);

  const selfRepo = path.join(f.home, '.rubato', 'memory', 'self', 'repo');
  assert.deepEqual(await f.service.handle('self', {}), { user: '', soul: '', repo: false });
  const saved = await f.service.handle('self-save', { file: 'user.md', content: '# user\n\n- 첫 줄' });
  assert.match(saved.commit, /^[0-9a-f]{40}$/);
  assert.equal(await readFile(path.join(selfRepo, 'user.md'), 'utf8'), '# user\n\n- 첫 줄\n');
  assert.match(git(selfRepo, 'log', '-1', '--format=%s'), /^user\.md: edit in settings \(\+\d+ -\d+\)$/);
  assert.equal((await f.service.handle('self-save', { file: 'user.md', content: '# user\n\n- 첫 줄\n' })).commit, null, 'no change, no commit');
  await f.service.handle('self-save', { file: 'soul.md', content: '말투: 반말\n', summary: '말투 정리' });
  assert.equal(git(selfRepo, 'log', '-1', '--format=%s'), 'soul.md: 말투 정리');
  await assert.rejects(f.service.handle('self-save', { file: '../x.md', content: '' }), /user\.md or soul\.md/);

  await pendingDream(f, 'dream-c', 'fourth');
  const added = await f.service.handle('add-candidates', { store: 'scratch', runId: 'dream-c', lines: ['base 에 바로 푸시한다'] });
  assert.equal(added.added, 1);
  assert.equal(await readFile(path.join(selfRepo, 'user.md'), 'utf8'), '# user\n\n- 첫 줄\n- base 에 바로 푸시한다\n');
  assert.match(git(selfRepo, 'log', '-1', '--format=%s'), /^user\.md: add 1 dream candidate from scratch dream-c$/);
  const detail = await f.service.handle('run', { store: 'scratch', runId: 'dream-c' });
  assert.deepEqual(detail.candidates.map((c) => c.inUser), [false, true]);
  await assert.rejects(f.service.handle('add-candidates', { store: 'scratch', runId: 'dream-c', lines: ['지어낸 줄'] }), /not in this run/);
});

test('HTTP exchange maps actions, bodies and errors', async (t) => {
  const f = await fixture(t);
  const call = async (action, body, method = 'POST') => {
    const response = await handleMemoryRequest(f.service, new Request(`http://x/rubato/memory/${action}`, {
      method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }));
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await call('self', undefined, 'GET'), { status: 200, body: { user: '', soul: '', repo: false } });
  assert.equal((await call('nope', {})).status, 404);
  assert.equal((await call('runs', { store: '../x' })).status, 400);
  assert.equal((await call('runs', 'not json')).status, 400);
  assert.equal((await call('self', undefined, 'DELETE')).status, 405);
});

test('stores are listed with their project, browsed, pruned and archived', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.repo, 'decisions'), { recursive: true });
  await writeFile(path.join(f.repo, 'decisions', 'gui.md'), '---\ndescription: "Settings copy is English"\n---\n\n# GUI\n');
  await writeFile(path.join(f.repo, 'decisions', 'plain.md'), '# no frontmatter\n');
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-q', '-m', 'decisions');
  await writeFile(path.join(f.store, 'store.json'), JSON.stringify({ roots: ['/work/scratch'] }));
  // An older store: no store.json, so where it belongs is unknown.
  const older = path.join(f.home, '.rubato', 'memory', 'agents', 'older', 'repo');
  await mkdir(older, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', older]);
  // A directory that is not a store is not listed.
  await mkdir(path.join(f.home, '.rubato', 'memory', 'agents', 'not-a-store'), { recursive: true });

  const listed = await f.service.handle('stores', {});
  assert.deepEqual(listed.stores.map((s) => [s.store, s.roots, s.home, s.files, s.enabled]), [
    ['scratch', ['/work/scratch'], false, 3, true],
    ['older', null, null, 0, false],
  ]);

  const browsed = await f.service.handle('files', { store: 'scratch' });
  assert.deepEqual(browsed.files, [
    { path: 'decisions/gui.md', description: 'Settings copy is English' },
    { path: 'decisions/plain.md', description: null },
    { path: 'notes.md', description: null },
  ]);
  assert.match((await f.service.handle('file', { store: 'scratch', path: 'decisions/gui.md' })).content, /# GUI/);
  for (const bad of ['../older/repo/x.md', '/etc/passwd', '.git/config', 'decisions/../../x', 'decisions\\gui.md'])
    await assert.rejects(f.service.handle('file', { store: 'scratch', path: bad }), /not valid|No file/, bad);
  const { symlink } = await import('node:fs/promises');
  await symlink('/etc/hosts', path.join(f.repo, 'link.md'));
  await assert.rejects(f.service.handle('file', { store: 'scratch', path: 'link.md' }), /not valid/);

  const removed = await f.service.handle('delete-file', { store: 'scratch', path: 'decisions/plain.md' });
  assert.match(removed.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(f.repo, 'log', '-1', '--format=%s'), 'Delete decisions/plain.md (Settings > Memory)');
  assert.equal(git(f.repo, 'ls-files', 'decisions/plain.md'), '');

  await assert.rejects(f.service.handle('delete-store', { store: 'scratch', confirm: 'scratc' }), /Type the store name/);
  const deleted = await f.service.handle('delete-store', { store: 'scratch', confirm: 'scratch' });
  assert.match(deleted.archive, new RegExp(`^${f.home}/\\.rubato/backups/scratch-.*\\.tgz$`));
  assert.equal((await f.service.handle('stores', {})).stores.some((s) => s.store === 'scratch'), false);
  const archived = execFileSync('tar', ['-tzf', deleted.archive], { encoding: 'utf8' });
  assert.match(archived, /^scratch\/repo\/decisions\/gui\.md$/m);
  await assert.rejects(f.service.handle('delete-store', { store: 'scratch', confirm: 'scratch' }), /No memory store/);
});

test('a newcomer has no stores yet', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-memory-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = createMemoryService({ env: { ...process.env, HOME: home, RUBATO_MEMORY_HOME: '' } });
  assert.deepEqual((await service.handle('stores', {})).stores, []);
});

test('project folders resolve to their store and can name one', { skip: !bunAvailable && 'bun is not installed' }, async (t) => {
  const f = await fixture(t);
  const repoProject = path.join(f.home, 'code', 'app');
  const plain = path.join(f.home, 'notes');
  await mkdir(repoProject, { recursive: true });
  await mkdir(plain, { recursive: true });
  execFileSync('git', ['init', '-q', repoProject]);

  const before = await f.service.handle('projects', { dirs: [repoProject, plain, f.home] });
  const byDir = Object.fromEntries(before.projects.map((entry) => [entry.dir, entry]));
  assert.deepEqual([byDir[repoProject].store, byDir[repoProject].source], ['app', 'git']);
  assert.deepEqual([byDir[plain].store, byDir[plain].source], [null, null]);
  assert.deepEqual([byDir[f.home].store, byDir[f.home].source], ['home', 'home']);

  await f.service.handle('project-store', { dir: plain, store: 'scratch' });
  const configFile = path.join(plain, '.rubato', 'rubato.jsonc');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).memory.agent, 'scratch');
  const named = (await f.service.handle('projects', { dirs: [plain] })).projects[0];
  assert.deepEqual([named.store, named.source, named.configured], ['scratch', 'config', 'scratch']);

  await f.service.handle('project-store', { dir: plain, store: null });
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).memory?.agent, undefined);
  assert.equal((await f.service.handle('projects', { dirs: [plain] })).projects[0].store, null);

  await assert.rejects(f.service.handle('project-store', { dir: 'relative/dir', store: 'x' }), /not valid/);
  await assert.rejects(f.service.handle('project-store', { dir: path.join(f.home, 'missing'), store: 'x' }), /does not exist/);
  await assert.rejects(f.service.handle('project-store', { dir: plain, store: '../x' }), /not valid/);
  await assert.rejects(f.service.handle('projects', { dirs: ['relative'] }), /absolute/);
});
