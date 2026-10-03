// The Memory tab's server half against the real `rubato dream` CLI, on a throwaway
// HOME: a store with dreams that landed, failed or were skipped, plus the file,
// config and self-store writes the tab makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ADOPT_SUBJECT, createMemoryService, handleMemoryRequest } from '../src/memory/service.mjs';

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

// Tests never reach this machine's real search index: msearch is a path that does not exist
// unless a test hands in its own.
async function fixture(t, { msearch = '/nonexistent/msearch' } = {}) {
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
  const service = createMemoryService({ env: { ...process.env, HOME: home, RUBATO_MEMORY_HOME: '' }, msearch });
  return { home, store, repo, service };
}

// What the runner leaves for a dream that landed: its branch merged into main, then deleted, and a run record.
async function landedDream({ store, repo }, runId, line, report = `## 요약\n\n${line}\n`, extra = {}) {
  const base = git(repo, 'rev-parse', 'HEAD');
  const branch = `dream/${runId}`;
  git(repo, 'branch', branch, base);
  const work = path.join(store, 'runtime', 'worktrees', runId);
  git(repo, 'worktree', 'add', '-q', work, branch);
  await writeFile(path.join(work, 'notes.md'), `${await readFile(path.join(work, 'notes.md'), 'utf8')}${line}\n`);
  git(work, 'commit', '-q', '-am', `dream: ${line}`);
  const commit = git(work, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'remove', '--force', work);
  git(repo, 'merge', '-q', '--no-ff', '-m', `merge(dream): ${runId}`, branch);
  git(repo, 'update-ref', '-d', `refs/heads/${branch}`);
  await writeRun(store, runId, {
    startedAt: '2026-09-26T01:00:00.000Z', finishedAt: '2026-09-26T01:10:00.000Z',
    status: 'merged', commits: [commit], baseRevision: base, ...extra,
  });
  const dir = path.join(store, 'runtime', 'dream', 'runs', runId);
  await writeFile(path.join(dir, 'out', 'report.md'), report);
  await writeFile(path.join(dir, 'out', 'user-candidates.md'), '# user-candidates\n\n- 한국어 반말을 좋아한다\n- base 에 바로 푸시한다\n');
  return { base, commit };
}

async function writeRun(store, runId, fields) {
  const dir = path.join(store, 'runtime', 'dream', 'runs', runId);
  await mkdir(path.join(dir, 'out'), { recursive: true });
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({
    runId, store: 'scratch', model: 'b-ai/deepseek-v4.1-flash', sessions: [{ id: 's1', cwd: '/tmp', messages: 3 }], commits: [], ...fields,
  }));
}

test('status, runs and diffs go through the real dream CLI', { skip: !bunAvailable && 'bun is not installed' }, async (t) => {
  const f = await fixture(t);
  await landedDream(f, 'dream-a', 'second', undefined, {
    attempts: [{ model: 'b-ai/deepseek-v4.1-flash', ok: false, error: 'credit insufficient' }, { model: 'xai/grok-4.7', ok: true }],
  });

  const status = await f.service.handle('status', {});
  assert.deepEqual(status.models, [
    { model: 'b-ai/deepseek-v4.1-flash', reasoning: 'medium' },
    { model: 'xai/grok-4.7', reasoning: null },
  ]);
  assert.equal('publish' in status, false);
  const scratch = status.stores.find((entry) => entry.store === 'scratch');
  assert.equal(scratch.enabled, true);
  assert.equal(scratch.running, null);

  const listed = await f.service.handle('runs', { store: 'scratch' });
  assert.deepEqual(listed.runs.map((run) => [run.runId, run.status, run.landed, run.sessions]), [['dream-a', 'merged', true, 1]]);
  assert.deepEqual(listed.runs[0].attempts, [{ model: 'b-ai/deepseek-v4.1-flash', ok: false, error: 'credit insufficient' }, { model: 'xai/grok-4.7', ok: true }]);

  const detail = await f.service.handle('run', { store: 'scratch', runId: 'dream-a' });
  assert.match(detail.report, /second/);
  assert.match(detail.changes[0].diff, /^\+second$/m, 'a landed run still shows what it changed');
  assert.match(detail.sources.report, /dream-a\/out\/report\.md$/);
  assert.match(detail.sources.range.head, /^[0-9a-f]{40}$/);
  assert.equal((await f.service.handle('stores', {})).stores.find((s) => s.store === 'scratch').repo, f.repo);

  for (const action of ['review', 'revert', 'ack']) await assert.rejects(f.service.handle(action, { store: 'scratch' }), /Unknown memory action/);
  await assert.rejects(f.service.handle('runs', { store: '../scratch' }), /not valid/);
  await assert.rejects(f.service.handle('run', { store: 'scratch', runId: '../../x' }), /not valid/);
  await assert.rejects(f.service.handle('runs', { store: 'ghost' }), /No memory store/);
});

test('a run reads as one card per changed file, and the store says how its last dream went', { skip: !bunAvailable && 'bun is not installed' }, async (t) => {
  const f = await fixture(t);
  const report = [
    '## 요약', '노트 한 줄을 더했다.',
    '## 바꾼 것', '- `notes.md`: rewritten — 두 번째 줄이 빠져 있었다',
    '## 푼 모순', '- `notes.md` vs `other.md`: kept notes.md, because 최신',
    '## 남긴 것', '- 상태 서술: git 이 이미 안다', '',
  ].join('\n');
  await landedDream(f, 'dream-a', 'second', report);
  // Read as the page gets it: through JSON, where an absent reason is no key at all.
  const lastRun = async () => JSON.parse(JSON.stringify((await f.service.handle('stores', {})).stores.find((s) => s.store === 'scratch').lastRun));

  const detail = await f.service.handle('run', { store: 'scratch', runId: 'dream-a' });
  assert.equal(detail.summary, '노트 한 줄을 더했다.');
  assert.deepEqual(detail.changes.map(({ diff, ...card }) => card), [{
    path: 'notes.md', change: 'modified', description: null, added: 1, removed: 0,
    notes: [{ kind: 'why', text: '두 번째 줄이 빠져 있었다' }, { kind: 'conflict', text: 'kept notes.md, because 최신' }],
  }]);
  assert.deepEqual(await lastRun(), {
    runId: 'dream-a', status: 'merged', startedAt: '2026-09-26T01:00:00.000Z', finishedAt: '2026-09-26T01:10:00.000Z', attempts: [], landed: true,
  });

  // A newer run that failed is the news; a skipped or trial run says nothing about the store.
  await writeRun(f.store, 'dream-b', { startedAt: '2026-09-27T01:00:00.000Z', status: 'failed', reason: 'merge failed: conflict' });
  await writeRun(f.store, 'dream-c', { startedAt: '2026-09-28T01:00:00.000Z', status: 'busy' });
  await writeRun(f.store, 'dream-d', { startedAt: '2026-09-29T01:00:00.000Z', status: 'trial' });
  assert.deepEqual(await lastRun(), {
    runId: 'dream-b', status: 'failed', startedAt: '2026-09-27T01:00:00.000Z', reason: 'merge failed: conflict', attempts: [], landed: false,
  });

  // A dream an earlier version held for approval and that was never approved did not land.
  await writeRun(f.store, 'dream-e', { startedAt: '2026-09-30T01:00:00.000Z', status: 'pending' });
  assert.equal((await lastRun()).landed, false);
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
  assert.ok(['failed', 'noop', 'busy', 'merged'].includes(last.status), JSON.stringify(last));
});

test('settings writes keep the user file and commit the self store', async (t) => {
  const f = await fixture(t);
  const configFile = path.join(f.home, '.rubato', 'rubato.jsonc');
  await f.service.handle('config', { models: [{ model: 'xai/grok-4.7', reasoning: 'high' }, { model: 'anthropic/claude-haiku-4-5' }] });
  await f.service.handle('config', { store: 'scratch', enabled: false });
  const text = await readFile(configFile, 'utf8');
  assert.match(text, /\/\/ 사용자 주석은 남아야 한다/);
  assert.match(text, /\/\/ 꼬리 주석/);
  assert.deepEqual(jsoncModels(text), [{ model: 'xai/grok-4.7', reasoning: 'high' }, { model: 'anthropic/claude-haiku-4-5' }]);
  assert.match(text, /"scratch": \{ "enabled": false \}|"scratch": \{\s*"enabled": false\s*\}/);
  assert.match(text, /"_migrations": \["2026-08-reasoning-unification"\]/);
  await assert.rejects(f.service.handle('config', { publish: 'review' }), /Nothing to change/);
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

  // What the dreams noticed about the user: every run's lines in one list, each once, newest first.
  await landedDream(f, 'dream-c', 'fourth');
  await landedDream(f, 'dream-d', 'fifth', undefined, { startedAt: '2026-09-27T01:00:00.000Z' });
  await writeFile(path.join(f.store, 'runtime', 'dream', 'runs', 'dream-d', 'out', 'user-candidates.md'), '- 짧은 답을 좋아한다\n- base 에 바로 푸시한다\n');
  const texts = async () => (await f.service.handle('suggestions', {})).suggestions.map((entry) => entry.text);
  assert.deepEqual(await texts(), ['짧은 답을 좋아한다', 'base 에 바로 푸시한다', '한국어 반말을 좋아한다']);
  const added = await f.service.handle('add-suggestions', { lines: ['base 에 바로 푸시한다'] });
  assert.equal(added.added, 1);
  assert.equal(await readFile(path.join(selfRepo, 'user.md'), 'utf8'), '# user\n\n- 첫 줄\n- base 에 바로 푸시한다\n');
  assert.equal(git(selfRepo, 'log', '-1', '--format=%s'), 'user.md: add 1 line the dream noticed');
  await f.service.handle('dismiss-suggestions', { lines: ['짧은 답을 좋아한다'] });
  assert.deepEqual(await texts(), ['한국어 반말을 좋아한다'], 'added and dismissed lines leave the list');
  await assert.rejects(f.service.handle('add-suggestions', { lines: ['지어낸 줄'] }), /not among the suggestions/);
  await assert.rejects(f.service.handle('dismiss-suggestions', { lines: [] }), /at least one/);
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
    ['older', null, null, 0, true],
  ]);
  // Every store dreams unless the config turns it off.
  await f.service.handle('config', { store: 'older', enabled: false });
  assert.equal((await f.service.handle('stores', {})).stores.find((s) => s.store === 'older').enabled, false);

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

  // An edit commits that file alone, under the user's words, or under a plain default.
  await writeFile(path.join(f.repo, 'notes.md'), 'first\nleft by a session\n');
  const edited = await f.service.handle('save-file', { store: 'scratch', path: 'decisions/gui.md', content: '---\ndescription: "Settings copy is English"\n---\n\n# GUI, edited\n', message: '설명 고침' });
  assert.match(edited.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(f.repo, 'log', '-1', '--format=%s'), '설명 고침');
  assert.equal(git(f.repo, 'show', '--name-only', '--format=', 'HEAD'), 'decisions/gui.md');
  assert.ok(git(f.repo, 'status', '--porcelain').split('\n').includes('M notes.md'), 'the session edit stays out of the commit');
  assert.equal((await f.service.handle('save-file', { store: 'scratch', path: 'decisions/gui.md', content: edited.content })).commit, null, 'no change, no commit');
  await f.service.handle('save-file', { store: 'scratch', path: 'decisions/gui.md', content: 'no frontmatter at all\n' });
  assert.equal(git(f.repo, 'log', '-1', '--format=%s'), 'Edit decisions/gui.md (Settings > Memory)');
  await assert.rejects(f.service.handle('save-file', { store: 'scratch', path: '../older/repo/x.md', content: 'x' }), /not valid/);
  await assert.rejects(f.service.handle('save-file', { store: 'scratch', path: 'decisions/new.md', content: 'x' }), /No file/);
  await assert.rejects(f.service.handle('save-file', { store: 'scratch', path: 'decisions/gui.md', content: 7 }), /under 1 MB/);
  git(f.repo, 'checkout', '--', 'notes.md');

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

test('the overview reads who changed what across stores, newest first', async (t) => {
  const f = await fixture(t);
  // The subject the page reads as "saved without a reason" is the one memory-core writes.
  const repoTs = await readFile(new URL('../../../packages/memory-core/src/git/repo.ts', import.meta.url), 'utf8');
  assert.equal(/export const ADOPT_COMMIT = "([^"]+)"/.exec(repoTs)?.[1], ADOPT_SUBJECT);

  const commitAt = (when, ...args) => execFileSync('git', ['-C', f.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  await writeFile(path.join(f.repo, 'tool.md'), '---\ndescription: by a tool\n---\n');
  git(f.repo, 'add', '-A');
  commitAt('2026-09-20T00:00:00Z', 'commit', '-q', '-m', '왜 이렇게 했나', '-m', 'Rubato-Writer: memory-tool');
  await writeFile(path.join(f.repo, 'shell.md'), 'written with a shell\n');
  git(f.repo, 'add', '-A');
  commitAt('2026-09-21T00:00:00Z', 'commit', '-q', '-m', ADOPT_SUBJECT);
  await landedDream(f, 'dream-a', 'second', '## 요약\n\n노트를 정리했다.\n');
  await f.service.handle('save-file', { store: 'scratch', path: 'tool.md', content: '---\ndescription: by me\n---\n', message: '내가 고침' });

  const { items } = await f.service.handle('activity', {});
  const read = items.map((item) => [item.kind, item.text, item.files.map((file) => `${file.change}:${file.path}`)]);
  assert.deepEqual(read.toSorted(), [
    ['dream', '노트를 정리했다.', ['modified:notes.md']],
    ['session', 'init', ['added:notes.md']],
    ['session', null, ['added:shell.md']],
    ['session', '왜 이렇게 했나', ['added:tool.md']],
    ['you', '내가 고침', ['modified:tool.md']],
  ].toSorted());
  assert.equal(items.find((item) => item.kind === 'dream').runId, 'dream-a');
  // Newest first: of the two dated commits, the later one comes first.
  assert.ok(read.findIndex(([, text]) => text === null) < read.findIndex(([, text]) => text === '왜 이렇게 했나'));
  assert.equal((await f.service.handle('activity', { limit: 2 })).items.length, 2);
});

test('search asks msearch across every store and falls back to plain text without it', async (t) => {
  const plain = await fixture(t);
  await mkdir(path.join(plain.repo, 'decisions'), { recursive: true });
  await writeFile(path.join(plain.repo, 'decisions', 'signing.md'), '---\ndescription: 앱 코드 서명\n---\n\n로컬 인증서로 서명한다.\n');
  const found = await plain.service.handle('search', { query: '인증서' });
  assert.deepEqual(found, { engine: 'plain', results: [{ store: 'scratch', path: 'decisions/signing.md', description: '앱 코드 서명', preview: '로컬 인증서로 서명한다.' }] });
  await assert.rejects(plain.service.handle('search', { query: '  ' }), /Type something/);

  // msearch names a file once per matching section and roots paths at the memory directory.
  const bin = path.join(plain.home, 'fake-msearch');
  const hit = (rel) => ({ rel_path: rel, content: '---\ndescription: 앱 코드 서명\n---\n## 결론\n로컬 인증서' });
  await writeFile(bin, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify([hit('scratch/repo/decisions/signing.md'), hit('scratch/repo/decisions/signing.md'), hit('../escape.md')])}\nEOF\n`, { mode: 0o755 });
  const viaMsearch = await createMemoryService({ env: { ...process.env, HOME: plain.home, RUBATO_MEMORY_HOME: '' }, msearch: bin }).handle('search', { query: '서명' });
  assert.deepEqual(viaMsearch, { engine: 'msearch', results: [{ store: 'scratch', path: 'decisions/signing.md', description: '앱 코드 서명', preview: '로컬 인증서' }] });
});
