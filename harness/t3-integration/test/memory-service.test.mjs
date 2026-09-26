// The 기억 tab's server half against the real `rubato dream` CLI, on a throwaway
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
  "[senpi]": {
    "categories": {
      "grok": { "models": [{ "model": "b-ai/deepseek-v4.1-flash" }, "xai/grok-4.7"] }
    }
  },
  "memory": {
    "dream": {
      "category": "grok", // 꼬리 주석
      "stores": { "scratch": { "enabled": true } }
    }
  },
  "_migrations": ["2026-08-reasoning-unification"]
}
`;

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
async function pendingDream({ store, repo }, runId, line) {
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
  await writeFile(path.join(dir, 'out', 'report.md'), `## 요약\n\n${line}\n`);
  await writeFile(path.join(dir, 'out', 'user-candidates.md'), '# user-candidates\n\n- 한국어 반말을 좋아한다\n- base 에 바로 푸시한다\n');
  await writeFile(path.join(store, 'runtime', 'dream', 'pending.json'), JSON.stringify({ runId, branch, baseRevision: base }));
  return { branch, base, commit };
}

test('status, review and diffs go through the real dream CLI', { skip: !bunAvailable && 'bun is not installed' }, async (t) => {
  const f = await fixture(t);
  await pendingDream(f, 'dream-a', 'second');

  const status = await f.service.handle('status', {});
  assert.equal(status.category, 'grok');
  assert.equal(status.publish, 'review');
  assert.deepEqual(status.categories, [{ name: 'grok', models: ['b-ai/deepseek-v4.1-flash', 'xai/grok-4.7'] }]);
  const scratch = status.stores.find((entry) => entry.store === 'scratch');
  assert.equal(scratch.enabled, true);
  assert.equal(scratch.pendingRunId, 'dream-a');
  assert.equal(scratch.running, null);

  const listed = await f.service.handle('runs', { store: 'scratch' });
  assert.deepEqual(listed.runs.map((run) => [run.runId, run.status, run.pending, run.sessions]), [['dream-a', 'pending', true, 1]]);

  const detail = await f.service.handle('run', { store: 'scratch', runId: 'dream-a' });
  assert.match(detail.report, /second/);
  assert.match(detail.diff, /^\+second$/m);
  assert.deepEqual(detail.candidates.map((c) => c.text), ['한국어 반말을 좋아한다', 'base 에 바로 푸시한다']);

  const approved = await f.service.handle('review', { store: 'scratch', decision: 'approve' });
  assert.equal(approved.review, 'merged');
  assert.equal(await readFile(path.join(f.repo, 'notes.md'), 'utf8'), 'first\nsecond\n');
  const merged = await f.service.handle('run', { store: 'scratch', runId: 'dream-a' });
  assert.equal(merged.review, 'merged');
  assert.equal(merged.pending, false);
  assert.match(merged.diff, /^\+second$/m, 'a merged run still shows what it changed');

  await pendingDream(f, 'dream-b', 'third');
  const rejected = await f.service.handle('review', { store: 'scratch', decision: 'reject' });
  assert.equal(rejected.review, 'rejected');
  assert.equal(await readFile(path.join(f.repo, 'notes.md'), 'utf8'), 'first\nsecond\n');
  assert.equal((await f.service.handle('status', {})).stores.find((entry) => entry.store === 'scratch').pendingRunId, undefined);

  await assert.rejects(f.service.handle('review', { store: 'scratch', decision: 'approve' }), /waiting for review/);
  await assert.rejects(f.service.handle('runs', { store: '../scratch' }), /not valid/);
  await assert.rejects(f.service.handle('run', { store: 'scratch', runId: '../../x' }), /not valid/);
  await assert.rejects(f.service.handle('runs', { store: 'ghost' }), /no memory store/);
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
  await f.service.handle('config', { category: 'fable' });
  await f.service.handle('config', { store: 'scratch', enabled: false });
  const text = await readFile(configFile, 'utf8');
  assert.match(text, /\/\/ 사용자 주석은 남아야 한다/);
  assert.match(text, /\/\/ 꼬리 주석/);
  assert.match(text, /"publish": "auto"/);
  assert.match(text, /"category": "fable"/);
  assert.match(text, /"scratch": \{ "enabled": false \}|"scratch": \{\s*"enabled": false\s*\}/);
  assert.match(text, /"_migrations": \["2026-08-reasoning-unification"\]/);
  await assert.rejects(f.service.handle('config', { publish: 'sometimes' }), /review or auto/);
  await assert.rejects(f.service.handle('config', { store: 'ghost', enabled: true }), /no memory store/);

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
