// The dream's document upkeep (dream/docs.mjs): when it is due, what it may write and where, the
// settings that drive it, and how the companion hears about it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCompanionService } from '../../t3-integration/src/companion/service.mjs';
import { DEFAULT_SETTINGS, DREAM_REASONING_LEVELS, readSettings, writeSettings, writeState } from '../companion.mjs';
import { REASONING_LEVELS } from '../../../packages/rubato-config-core/src/schema/reasoning-vocabulary.ts';
import { heartbeatText } from '../control-tower.mjs';
import { DOCS_CADENCE_HOURS, docsDue, docsReportLine, immutableFiles, runDocsDream } from '../dream/docs.mjs';
import { DREAM_MODELS, companionDreamModels, dreamPaths, readDreamState, releaseLock, runCompanionDream, takeLock } from '../dream/dream.mjs';
import { dreamNight, resolveModels } from '../dream/service.mjs';
import { companionSettings } from '../settings.mjs';
import { appEntry } from '../messenger/test/helpers.mjs';
import { dreamLadder } from '../../../packages/rubato-runtime/src/dream/ladder.ts';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const darwin = process.platform === 'darwin';
const ID = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const launch = { command: 'node', prefixArgs: ['cli.js'], env: {} };

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-docs-dream-'));
  // Locked fixtures are unlocked before the folder goes.
  t.after(() => { if (darwin) try { execFileSync('chflags', ['-R', 'nouchg', dir]); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const env = { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion'), RUBATO_PI_CODING_AGENT_DIR: path.join(dir, 'agent'),
    PATH: process.env.PATH, MSEARCH_STATE_DIR: path.join(dir, 'msearch-state') };
  mkdirSync(path.join(env.RUBATO_COMPANION_HOME, 'memory'), { recursive: true });
  mkdirSync(path.join(env.RUBATO_COMPANION_HOME, 'prompt'), { recursive: true });
  return { dir, env, home: env.RUBATO_COMPANION_HOME };
}

const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file; };

/** A repository the user works in, pushed to a bare remote, with a locked canonical document. */
function userRepo(dir) {
  const repo = path.join(dir, 'work', 'project');
  put(path.join(repo, 'docs', 'runbook.md'), '# Runbook\nDeploy with make ship.\n');
  put(path.join(repo, 'docs', 'copy.md'), '# Copy\nDeploy with make ship.\n');
  put(path.join(repo, 'docs', 'money.md'), '# Money canonical\nLocked.\n');
  put(path.join(repo, 'README.md'), '# Project\n');
  put(path.join(repo, 'src', 'ship.js'), 'export const ship = "make release";\n');
  git(path.dirname(repo), 'init', '--quiet', '-b', 'master', repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'start');
  const remote = path.join(dir, 'remote.git');
  git(dir, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'fetch', '--quiet', 'origin');
  if (darwin) execFileSync('chflags', ['uchg', path.join(repo, 'docs', 'money.md')]);
  return { repo, remote, head: git(repo, 'rev-parse', 'HEAD').trim() };
}

/** A child that tends documents the way docs.md asks: reads the plan, edits its roots, reports. */
function fakeTender({ work, result = { status: 'done', message: '배포 절차를 runbook 하나로', decide: 1 }, code = 0, report = '## 바꾼 것\n- 배포: 정본 runbook' } = {}) {
  const seen = [];
  const spawnChild = async ({ cwd, env, logPath }) => {
    const plan = JSON.parse(readFileSync(path.join(env.DREAM_RUN_DIR, 'plan.json'), 'utf8'));
    seen.push({ plan, cwd, env });
    if (code !== 0) { writeFileSync(logPath, 'provider error: quota\n'); return { code }; }
    work?.({ plan, cwd, env });
    writeFileSync(plan.out.report, report);
    writeFileSync(plan.out.result, JSON.stringify(result));
    writeFileSync(logPath, `DOCS_DONE at=${plan.runAt}\n`);
    return { code: 0 };
  };
  return { spawnChild, seen };
}

test('the docs job comes on its own cadence, only with roots, and a first run is due at once', () => {
  const roots = [{ path: '/tmp/x', mode: 'report' }];
  const settings = (cadence, list = roots) => ({ dream: { docs: { cadence, roots: list } } });
  assert.equal(DEFAULT_SETTINGS.dream.docs.cadence, 'weekly');
  assert.deepEqual(DEFAULT_SETTINGS.dream.docs.roots, []);
  assert.equal(docsDue({ at: at(21, 4), settings: settings('weekly', []) }).due, false, 'no roots: never');
  assert.equal(docsDue({ at: at(21, 4), settings: settings('off') }).due, false);
  assert.equal(docsDue({ at: at(21, 4), settings: settings('off'), manual: true }).due, true, 'a hand-started run with roots goes');
  assert.equal(docsDue({ at: at(21, 4), settings: settings('weekly') }).due, true, 'never ran: due');
  const ran = (hoursAgo) => ({ blocks: { docs: { lastAt: new Date(at(21, 4) - hoursAgo * 3_600_000).toISOString() } } });
  assert.equal(docsDue({ at: at(21, 4), state: ran(DOCS_CADENCE_HOURS.weekly - 1), settings: settings('weekly') }).due, false);
  assert.equal(docsDue({ at: at(21, 4), state: ran(DOCS_CADENCE_HOURS.weekly), settings: settings('weekly') }).due, true);
  assert.equal(docsDue({ at: at(21, 4), state: ran(DOCS_CADENCE_HOURS.daily), settings: settings('daily') }).due, true);
  assert.equal(docsDue({ at: at(21, 4), state: ran(200), settings: settings('monthly') }).due, false);
  // The memory dream's own blocks are not the docs job's clock.
  assert.equal(docsDue({ at: at(21, 4), state: { blocks: { distill: { lastAt: new Date(at(21, 3)).toISOString() } } }, settings: settings('weekly') }).due, true);
});

test('the user sets the docs job by talking to the companion, and the Settings page reads and changes the same values', async (t) => {
  const { dir, env, home } = sandbox(t);
  const sessionsDir = path.join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeState({ sessionId: 'S1' }, env);
  writeFileSync(path.join(sessionsDir, '2026-10-20T00-00-00-000Z_S1.jsonl'), `${JSON.stringify(appEntry('u1', '레포 문서도 꿈에서 정리해줘'))}\n`);
  const service = createCompanionService({ env, defaultsDir, telegram: false });
  const call = (request) => companionSettings({ sessionId: 'S1', sessionsDir, env, service, request, telegram: false });

  const shown = await call({ action: 'show' });
  assert.deepEqual(shown.settings.companion.dream, { models: [], docs: { cadence: 'weekly', roots: [] } });
  const roots = [{ path: path.join(home, 'memory'), mode: 'edit' }, { path: '~/work/project/docs', mode: 'branch' }, { path: '/srv/money', mode: 'report' }];
  const answer = await call({ action: 'change', change: { companion: { dream: { docs: { roots, cadence: 'daily' } } } } });
  assert.deepEqual(answer.settings.companion.dream.docs, { cadence: 'daily', roots });
  assert.deepEqual((await service.handle('status', {})).settings.dream.docs, answer.settings.companion.dream.docs, 'the page shows what the talk set');

  // The page changes the cadence; the roots the companion set stay.
  await service.handle('save-settings', { patch: { dream: { docs: { cadence: 'monthly' } } } });
  assert.deepEqual(readSettings(env).dream.docs, { cadence: 'monthly', roots });
  // The page edits the list the same way: the whole list back, through the same checks.
  const fewer = roots.slice(0, 2).map((root, index) => (index === 1 ? { ...root, mode: 'report' } : root));
  await service.handle('save-settings', { patch: { dream: { docs: { roots: fewer } } } });
  assert.deepEqual((await call({ action: 'show' })).settings.companion.dream.docs, { cadence: 'monthly', roots: fewer }, 'the companion sees what the page set');
  await assert.rejects(service.handle('save-settings', { patch: { dream: { docs: { roots: [...fewer, { path: '/srv/repo', mode: 'edit' }] } } } }),
    (error) => error.code === 'invalid' && /inside the companion's home/.test(error.message));
  await service.handle('save-settings', { patch: { dream: { docs: { roots } } } });

  for (const bad of [
    { roots: [{ path: '/srv/repo', mode: 'edit' }] },
    { roots: [{ path: path.join(home, 'notes'), mode: 'branch' }] },
    { roots: [{ path: 'relative/docs', mode: 'report' }] },
    { roots: [{ path: '/srv/repo', mode: 'push' }] },
    { cadence: 'hourly' },
  ]) {
    await assert.rejects(call({ action: 'change', change: { companion: { dream: { docs: bad } } } }), (error) => error.code === 'invalid', JSON.stringify(bad));
  }
  await assert.rejects(call({ action: 'change', change: { companion: { dream: { docs: { bogus: 1 } } } } }), /Not a setting: companion.dream.docs.bogus/);
  assert.deepEqual(readSettings(env).dream.docs, { cadence: 'monthly', roots }, 'a refused change left the settings as they were');
});

test('a branch root is tended in a worktree: Rubato commits inside the root on a new branch, puts back the rest, and the user\'s checkout, branches and remote stay as they were', async (t) => {
  const { dir, env } = sandbox(t);
  const { repo, remote, head } = userRepo(dir);
  writeSettings({ dream: { docs: { roots: [{ path: path.join(repo, 'docs'), mode: 'branch' }] } } }, env);
  const tender = fakeTender({ work({ plan }) {
    const [root] = plan.roots;
    assert.equal(root.mode, 'branch');
    assert.equal(root.base, head.slice(0, 12));
    assert.ok(!root.work.startsWith(repo + path.sep), 'the child works outside the user\'s checkout');
    const worktree = path.dirname(root.work);
    writeFileSync(path.join(root.work, 'copy.md'), '# Copy\nSee [runbook](runbook.md).\n');
    // A commit the child makes itself is folded into Rubato's one commit.
    writeFileSync(path.join(root.work, 'runbook.md'), '# Runbook\nDeploy with make ship.\n\nCanonical.\n');
    git(worktree, 'commit', '--quiet', '-am', 'child commit');
    writeFileSync(path.join(worktree, 'README.md'), '# Project\nrewritten outside the root\n');
    writeFileSync(path.join(worktree, 'src', 'ship.js'), 'export const ship = "make ship";\n');
    if (darwin) {
      assert.deepEqual(root.locked, [path.join(root.work, 'money.md')]);
      assert.throws(() => writeFileSync(path.join(root.work, 'money.md'), 'changed'), /EPERM/, 'a locked file is locked in the worktree too');
    }
  } });
  const record = await runDocsDream({ env, settings: readSettings(env), launch, spawnChild: tender.spawnChild, now: () => at(21, 4, 30), defaultsDir });

  assert.equal(record.status, 'partial', JSON.stringify(record));
  assert.deepEqual(record.branches.map((item) => item.branch), ['dream/docs-20261021']);
  const branch = 'dream/docs-20261021';
  assert.equal(git(repo, 'rev-parse', `${branch}^`).trim(), head, 'one commit on top of the checkout\'s commit');
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=%s', branch).trim().split('\n').filter(Boolean),
    ['dream(docs): 배포 절차를 runbook 하나로', 'docs/copy.md', 'docs/runbook.md']);
  assert.equal(git(repo, 'show', `${branch}:README.md`), '# Project\n', 'outside the root is put back');
  assert.equal(git(repo, 'show', `${branch}:src/ship.js`), 'export const ship = "make release";\n', 'code is not the docs job\'s');
  assert.deepEqual(record.reverted.map((item) => item.path).sort(), ['README.md', 'src/ship.js']);

  // The user's side: same commit, same branch, clean tree, no extra worktree, nothing pushed.
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD').trim(), 'master');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.doesNotMatch(git(remote, 'branch', '--list'), /dream\//);
  assert.deepEqual(record.sourceChanged, []);
  if (darwin) assert.equal(readFileSync(path.join(repo, 'docs', 'money.md'), 'utf8'), '# Money canonical\nLocked.\n');

  // The report names the branch and what was put back; the companion hears about it once.
  const report = readFileSync(record.report, 'utf8');
  assert.match(report, /## 바꾼 것/);
  assert.match(report, /dream\/docs-20261021/);
  assert.match(report, /되돌림: README\.md \(정리 대상 밖\)/);
  const state = readDreamState(env);
  assert.equal(state.blocks.docs.runId, record.runId);
  assert.equal(state.docsReport.decide, 1);
  const line = docsReportLine(env);
  assert.equal(line.line, `DOCS_REPORT file="${record.report}" branches=1 decide=1`);
  assert.equal(docsReportLine(env, record.runId), undefined, 'shown once');
  assert.match(heartbeatText({ tick: 1, at: at(21, 9), docs: line.line }), /\nDOCS_REPORT file=/);

  // A second run the same day gets its own branch name; the first one stays.
  const again = await runDocsDream({ env, settings: readSettings(env), launch, manual: true, now: () => at(21, 5),
    spawnChild: fakeTender({ work: ({ plan }) => writeFileSync(path.join(plan.roots[0].work, 'copy.md'), 'again\n') }).spawnChild, defaultsDir });
  assert.deepEqual(again.branches.map((item) => item.branch), ['dream/docs-20261021-2']);
});

test('a run that writes into the user\'s checkout is named in the report, and a failed run leaves no branch, no worktree and the watermark where it was', async (t) => {
  const { dir, env } = sandbox(t);
  const { repo, head } = userRepo(dir);
  writeSettings({ dream: { docs: { roots: [{ path: path.join(repo, 'docs'), mode: 'branch' }, { path: path.join(dir, 'notes-folder'), mode: 'report' }] } } }, env);
  put(path.join(dir, 'notes-folder', 'a.md'), 'read only\n');
  const stray = fakeTender({ work() {
    writeFileSync(path.join(repo, 'docs', 'runbook.md'), 'written straight into the checkout\n');
    writeFileSync(path.join(dir, 'notes-folder', 'a.md'), 'written into a report root\n');
  } });
  const record = await runDocsDream({ env, settings: readSettings(env), launch, spawnChild: stray.spawnChild, now: () => at(21, 4, 30), defaultsDir });
  assert.equal(record.status, 'partial');
  assert.deepEqual([...record.sourceChanged].sort(), [path.join(dir, 'notes-folder'), repo].map((item) => execFileSync('realpath', [item], { encoding: 'utf8' }).trim()).sort());
  assert.match(readFileSync(record.report, 'utf8'), /확인 필요/);
  assert.deepEqual(record.branches, []);
  git(repo, 'checkout', '--quiet', '--', 'docs/runbook.md');

  const before = readDreamState(env).blocks.docs;
  const failing = await runDocsDream({ env, settings: readSettings(env), launch, manual: true, models: DREAM_MODELS, now: () => at(28, 4, 30),
    spawnChild: fakeTender({ code: 1 }).spawnChild, defaultsDir });
  assert.equal(failing.status, 'failed');
  assert.deepEqual(failing.sourceChanged, [], 'compared on failure too');
  assert.notEqual(readDreamState(env).docsReport.runId, failing.runId, 'a failure that touched nothing is not announced');
  // A failed run whose child still wrote into the checkout is compared and announced.
  const touching = await runDocsDream({ env, settings: readSettings(env), launch, manual: true, models: DREAM_MODELS.slice(0, 1), now: () => at(28, 5),
    spawnChild: async ({ logPath }) => { writeFileSync(path.join(repo, 'docs', 'copy.md'), 'half a rewrite\n'); writeFileSync(logPath, 'quota\n'); return { code: 1 }; },
    defaultsDir });
  assert.equal(touching.status, 'failed');
  assert.equal(touching.sourceChanged.length, 1);
  assert.equal(readDreamState(env).docsReport.runId, touching.runId);
  git(repo, 'checkout', '--quiet', '--', 'docs/copy.md');
  assert.equal(failing.attempts.length, DREAM_MODELS.length);
  assert.deepEqual(readDreamState(env).blocks.docs, before, 'tried again next time');
  assert.equal(git(repo, 'branch', '--list', 'dream/*').trim(), '');
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
});

test('an edit root in the home brings back only its own memory and notes files, never the resident memory or prompt, and commits them in the home', async (t) => {
  const { env, home } = sandbox(t);
  put(path.join(home, 'memory', 'work', 'deploy.md'), '# 배포\nmake ship\n');
  put(path.join(home, 'memory', 'entities', 'ship.md'), '# ship\n배포는 make ship\n');
  put(path.join(home, 'memory', 'MEMORY.md'), '# 기억\n');
  put(path.join(home, 'prompt', 'soul.md'), '나\n');
  const locked = put(path.join(home, 'memory', 'money.md'), '# 돈 정본\n');
  if (darwin) execFileSync('chflags', ['uchg', locked]);
  writeSettings({ dream: { docs: { roots: [{ path: '~/companion/memory', mode: 'edit' }] } } }, env);
  const tender = fakeTender({ work({ plan, cwd }) {
    assert.equal(plan.roots[0].work, path.join(cwd, 'memory'));
    writeFileSync(path.join(cwd, 'memory', 'entities', 'ship.md'), '# ship\n배포 절차: [정본](../work/deploy.md)\n');
    writeFileSync(path.join(cwd, 'memory', 'MEMORY.md'), '# 기억\n문서 정리가 고침\n');
    writeFileSync(path.join(cwd, 'prompt', 'soul.md'), '바뀐 나\n');
    if (darwin) assert.throws(() => writeFileSync(path.join(cwd, 'memory', 'money.md'), 'x'), /EPERM/);
  } });
  const record = await runDocsDream({ env, settings: readSettings(env), launch, spawnChild: tender.spawnChild, now: () => at(21, 4, 30), defaultsDir });
  assert.deepEqual(record.home.applied, ['memory/entities/ship.md'], JSON.stringify(record));
  assert.match(readFileSync(path.join(home, 'memory', 'entities', 'ship.md'), 'utf8'), /정본/);
  assert.equal(readFileSync(path.join(home, 'memory', 'MEMORY.md'), 'utf8'), '# 기억\n');
  assert.equal(readFileSync(path.join(home, 'prompt', 'soul.md'), 'utf8'), '나\n');
  assert.equal(readFileSync(locked, 'utf8'), '# 돈 정본\n');
  assert.match(execFileSync('git', ['-C', home, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /^dream\(docs\): /);
});

test('the memory dream no longer fails its whole night on a locked file: the file stays and the run says so', { skip: !darwin }, async (t) => {
  const { env, home } = sandbox(t);
  put(path.join(home, 'memory', '2026-10-20.md'), '## 10:05\n하루');
  const locked = put(path.join(home, 'memory', 'work', 'money.md'), '# 돈 정본\n');
  execFileSync('chflags', ['uchg', locked]);
  const spawnChild = async ({ cwd, env: childEnv, logPath }) => {
    writeFileSync(path.join(cwd, 'memory', 'work', 'money.md'), '# 돈 정본\n꿈이 고침\n');
    writeFileSync(path.join(cwd, 'memory', 'user.md'), '## 지금\n- 하루\n');
    writeFileSync(path.join(childEnv.DREAM_OUT_DIR, 'result.json'), JSON.stringify({ status: 'done', blocks: { distill: 'done' }, message: '하루' }));
    writeFileSync(logPath, 'MEMORY_DONE\n');
    return { code: 0 };
  };
  const record = await runCompanionDream({ env, launch, spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(record.status, 'partial', JSON.stringify(record));
  assert.deepEqual(record.changed, ['memory/user.md']);
  assert.deepEqual(record.guarded.map((item) => item.path), ['memory/work/money.md']);
  assert.equal(readFileSync(locked, 'utf8'), '# 돈 정본\n');
});

test('immutable files are found by their flag, not by their name', { skip: !darwin }, (t) => {
  const { dir } = sandbox(t);
  const plain = put(path.join(dir, 'f', 'plain.md'), 'a');
  const locked = put(path.join(dir, 'f', 'locked.md'), 'b');
  put(path.join(dir, 'f', 'node_modules', 'x.md'), 'c');
  execFileSync('chflags', ['uchg', locked]);
  assert.deepEqual(immutableFiles(path.join(dir, 'f')), [locked]);
  assert.deepEqual(immutableFiles(plain), []);
  assert.deepEqual(immutableFiles(path.join(dir, 'f'), 'linux'), [], 'no such flag elsewhere');
});

test('the companion dream runs on the dream ladder the user set in rubato.jsonc, and on its own models when none is set', async (t) => {
  const { dir } = sandbox(t);
  const env = { HOME: dir };
  assert.equal(await resolveModels(env), DREAM_MODELS, 'no config file');
  put(path.join(dir, '.rubato', 'rubato.jsonc'), '{\n  // 꿈\n  "memory": { "dream": { "enabled": false, },\n  },\n}\n');
  assert.equal(await resolveModels(env), DREAM_MODELS, 'a config without a ladder: the schema default is not the user\'s choice');
  put(path.join(dir, '.rubato', 'rubato.jsonc'), '{ "memory": { "dream": { "models": [ { "model": "xai/grok-4.7", "reasoning": "medium" }, "anthropic/claude-haiku-5-5" ] } } }');
  const readErrors = [];
  const ladder = await resolveModels(env, (error) => readErrors.push(error.message));
  assert.deepEqual(readErrors, [], 'the user\'s file is read, not skipped for a missing parser');
  assert.deepEqual(ladder, [{ model: 'xai/grok-4.7', thinking: 'medium' }, { model: 'anthropic/claude-haiku-5-5' }]);
  assert.equal(companionDreamModels({ memory: { dream: { models: ['not-a-model', { reasoning: 'high' }] } } }, dreamLadder), DREAM_MODELS,
    'nothing launchable falls back');
  const errors = [];
  put(path.join(dir, '.rubato', 'rubato.jsonc'), '{ "memory": { "dream": { "models": [ { "model": 3 } ] } } }');
  assert.equal(await resolveModels(env, (error) => errors.push(error)), DREAM_MODELS);
});

test('a night is the memory dream, then the docs job; the docs job neither hides nor breaks the memory record', async (t) => {
  const { env } = sandbox(t);
  const memory = { status: 'done', runId: 'dream-1' };
  assert.deepEqual(await dreamNight({ env, runMemory: async () => memory, runDocs: async () => ({ status: 'not-due' }) }), memory);
  const order = [];
  const night = await dreamNight({ env, runMemory: async () => { order.push('memory'); return memory; },
    runDocs: async (settings) => { order.push('docs'); assert.ok(settings.dream.docs); throw new Error('worktree add failed'); } });
  assert.deepEqual(order, ['memory', 'docs']);
  assert.equal(night.status, 'done');
  assert.deepEqual(night.docs, { status: 'failed', reason: 'worktree add failed' });
});

test('the commit is built from the worktree\'s files, not from what the child did to its index, HEAD or branches', async (t) => {
  const { dir, env } = sandbox(t);
  const { repo, head } = userRepo(dir);
  put(path.join(repo, 'docs', 'extra.md'), 'second commit\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'second');
  git(repo, 'branch', 'feature', head);
  const second = git(repo, 'rev-parse', 'HEAD').trim();
  writeSettings({ dream: { docs: { roots: [{ path: path.join(repo, 'docs'), mode: 'branch' }] } } }, env);
  const tender = fakeTender({ work({ plan }) {
    const worktree = path.dirname(plan.roots[0].work);
    writeFileSync(path.join(worktree, 'docs', 'copy.md'), 'See runbook.\n');
    writeFileSync(path.join(worktree, 'staged-outside.txt'), 'staged by the child\n');
    git(worktree, 'add', 'staged-outside.txt');
    symlinkSync('/etc/hosts', path.join(worktree, 'docs', 'escape.md'));
    git(worktree, 'switch', '--quiet', '-c', 'child-branch');
    git(worktree, 'commit', '--quiet', '-m', 'the child commits on its own branch');
  } });
  const record = await runDocsDream({ env, settings: readSettings(env), launch, spawnChild: tender.spawnChild, now: () => at(21, 4, 30), defaultsDir });
  const branch = record.branches[0].branch;
  assert.equal(git(repo, 'rev-parse', `${branch}^`).trim(), second);
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', branch).trim().split('\n'), ['docs/copy.md']);
  assert.deepEqual(record.reverted.map((item) => `${item.path}:${item.reason}`).sort(), ['docs/escape.md:link', 'staged-outside.txt:outside the roots']);
  assert.equal(git(repo, 'rev-parse', 'feature').trim(), head, 'an existing branch is not moved');
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), second);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(record.sourceChanged.length, 1, 'the branch the child made in the shared repository is named');
});

test('a dream folder or report file linked outside the home runs nothing', async (t) => {
  const { dir, env } = sandbox(t);
  const outside = path.join(dir, 'outside');
  mkdirSync(outside);
  mkdirSync(dreamPaths(env).dir, { recursive: true });
  symlinkSync(outside, path.join(dreamPaths(env).dir, 'docs'));
  put(path.join(dir, 'notes-folder', 'a.md'), 'x\n');
  writeSettings({ dream: { docs: { roots: [{ path: path.join(dir, 'notes-folder'), mode: 'report' }] } } }, env);
  const tender = fakeTender();
  const record = await runDocsDream({ env, settings: readSettings(env), launch, spawnChild: tender.spawnChild, now: () => at(21, 4, 30), defaultsDir });
  assert.equal(record.status, 'failed');
  assert.match(record.reason, /outside the companion's home/);
  assert.equal(tender.seen.length, 0);
  assert.equal(existsSync(path.join(outside, '2026-10-21.md')), false);
});

test('an edit root never writes through a hard link', async (t) => {
  const { dir, env, home } = sandbox(t);
  const shared = put(path.join(dir, 'elsewhere.md'), 'shared\n');
  mkdirSync(path.join(home, 'notes'), { recursive: true });
  linkSync(shared, path.join(home, 'notes', 'linked.md'));
  writeSettings({ dream: { docs: { roots: [{ path: path.join(home, 'notes'), mode: 'edit' }] } } }, env);
  const record = await runDocsDream({ env, settings: readSettings(env), launch, now: () => at(21, 4, 30), defaultsDir,
    spawnChild: fakeTender({ work: ({ cwd }) => writeFileSync(path.join(cwd, 'notes', 'linked.md'), 'rewritten\n') }).spawnChild });
  assert.deepEqual(record.home.applied, []);
  assert.equal(readFileSync(shared, 'utf8'), 'shared\n');
});

test('the dream lock is not taken from a living dream, and a run lets go only of its own lock', (t) => {
  const { env } = sandbox(t);
  const lock = dreamPaths(env).lock;
  mkdirSync(path.dirname(lock), { recursive: true });
  const old = at(21, 1);
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: old }));
  assert.equal(takeLock(lock, at(21, 5)), false, 'three hours old, but its process is alive');
  writeFileSync(lock, JSON.stringify({ pid: 999_999_9, at: old }));
  assert.equal(takeLock(lock, at(21, 5)), true, 'its process is gone');
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: at(21, 5) }));
  releaseLock(lock, at(21, 5));
  assert.equal(existsSync(lock), true, 'another holder\'s lock stays');
});

test('a memory dream whose result could not be written to a locked file reads the same ground again', { skip: !darwin }, async (t) => {
  const { env, home } = sandbox(t);
  put(path.join(home, 'memory', '2026-10-20.md'), '## 10:05\n하루');
  const locked = put(path.join(home, 'memory', 'user.md'), '## 지금\n');
  execFileSync('chflags', ['uchg', locked]);
  const spawnChild = async ({ cwd, env: childEnv, logPath }) => {
    writeFileSync(path.join(cwd, 'memory', 'user.md'), '## 지금\n- 하루\n');
    writeFileSync(path.join(childEnv.DREAM_OUT_DIR, 'result.json'), JSON.stringify({ status: 'done', blocks: { distill: 'done' }, message: '하루' }));
    writeFileSync(logPath, 'MEMORY_DONE\n');
    return { code: 0 };
  };
  const record = await runCompanionDream({ env, launch, spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(record.watermarks, 'held');
  assert.equal(readDreamState(env).blocks?.distill, undefined);
});

test('the same place cannot be named twice with two modes', async (t) => {
  const { env } = sandbox(t);
  assert.throws(() => writeSettings({ dream: { docs: { roots: [{ path: '/srv/repo/docs', mode: 'branch' }, { path: '/srv/repo/docs/', mode: 'report' }] } } }, env),
    /twice/);
});

test('the ladder honours the [senpi] section, drops an unknown reasoning level, and a file that does not parse is not a ladder', async (t) => {
  const { dir } = sandbox(t);
  const env = { HOME: dir };
  put(path.join(dir, '.rubato', 'rubato.jsonc'), JSON.stringify({ memory: { dream: { models: ['xai/grok-4.7'] } },
    '[senpi]': { memory: { dream: { models: [{ model: 'anthropic/claude-sonnet-5-5', reasoning: 'nonsense' }] } } } }));
  assert.deepEqual(await resolveModels(env), [{ model: 'anthropic/claude-sonnet-5-5' }]);
  put(path.join(dir, '.rubato', 'rubato.jsonc'), '{ "memory": { "dream": { "models": [ "example/model"');
  const errors = [];
  assert.equal(await resolveModels(env, (error) => errors.push(error)), DREAM_MODELS);
  assert.match(errors[0].message, /does not parse/);
});

/** A one-root branch run with `work` as the child's hands; returns the record and the repository. */
async function branchRun(t, { setup, work, roots = (repo) => [{ path: path.join(repo, 'docs'), mode: 'branch' }] } = {}) {
  const { dir, env } = sandbox(t);
  const fixture = userRepo(dir);
  setup?.({ ...fixture, dir });
  writeSettings({ dream: { docs: { roots: roots(fixture.repo, dir) } } }, env);
  const record = await runDocsDream({ env, settings: readSettings(env), launch, now: () => at(21, 4, 30), defaultsDir,
    spawnChild: fakeTender({ work: (args) => work?.({ ...args, ...fixture, dir, worktree: path.dirname(args.plan.roots[0]?.work ?? '') }) }).spawnChild });
  return { record, ...fixture, dir, env };
}

test('a sparse checkout\'s absent files and a line-ending filter are not changes: a run that edits nothing makes no branch', async (t) => {
  const sparse = await branchRun(t, { setup({ repo }) {
    put(path.join(repo, 'docs', 'private', 'guide.md'), 'kept in the commit, not in the checkout\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'private guide');
    git(repo, 'sparse-checkout', 'set', '--no-cone', '/*', '!/docs/private/');
  } });
  assert.equal(sparse.record.status, 'done', JSON.stringify(sparse.record));
  assert.deepEqual(sparse.record.branches, []);
  assert.equal(existsSync(path.join(sparse.repo, 'docs', 'private', 'guide.md')), false, 'the user\'s sparse checkout is as it was');

  const crlf = await branchRun(t, { setup({ repo }) {
    put(path.join(repo, '.gitattributes'), 'docs/*.md text eol=crlf\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'crlf');
  } });
  assert.deepEqual(crlf.record.branches, [], JSON.stringify(crlf.record));
});

test('the finished tree never changes a locked file, not through its folder and not through a link to outside', { skip: !darwin }, async (t) => {
  const { record, repo } = await branchRun(t, {
    setup({ repo }) {
      put(path.join(repo, 'docs', 'internal', 'locked.md'), '# locked\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '--quiet', '-m', 'internal');
      execFileSync('chflags', ['uchg', path.join(repo, 'docs', 'internal', 'locked.md')]);
    },
    work({ worktree, dir }) {
      // The child lifts the lock and turns the folder into a file, and points another folder outside.
      execFileSync('chflags', ['-R', 'nouchg', path.join(worktree, 'docs', 'internal')]);
      rmSync(path.join(worktree, 'docs', 'internal'), { recursive: true });
      writeFileSync(path.join(worktree, 'docs', 'internal'), 'a file now\n');
      put(path.join(dir, 'outside', 'runbook.md'), 'bytes from outside\n');
      rmSync(path.join(worktree, 'docs', 'runbook.md'));
      symlinkSync(path.join(dir, 'outside', 'runbook.md'), path.join(worktree, 'docs', 'runbook.md'));
      writeFileSync(path.join(worktree, 'docs', 'copy.md'), 'See runbook.\n');
    },
  });
  const branch = record.branches[0].branch;
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', branch).trim().split('\n'), ['docs/copy.md']);
  assert.equal(git(repo, 'show', `${branch}:docs/internal/locked.md`), '# locked\n');
  assert.equal(git(repo, 'show', `${branch}:docs/runbook.md`), '# Runbook\nDeploy with make ship.\n');
  assert.deepEqual(record.reverted.map((item) => `${item.path}:${item.reason}`),
    ['docs/internal:locked', 'docs/internal/locked.md:locked', 'docs/runbook.md:link']);
});

test('names with tabs are committed as they are, and the run leaves no index of its own behind', async (t) => {
  const { record, repo, env } = await branchRun(t, {
    setup({ repo }) { put(path.join(repo, 'docs', 'a\tb.md'), 'tab\n'); git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'tab'); },
    work({ worktree }) { writeFileSync(path.join(worktree, 'docs', 'a\tb.md'), 'tab, tidied\n'); },
  });
  const branch = record.branches[0].branch;
  assert.equal(git(repo, 'show', `${branch}:docs/a\tb.md`), 'tab, tidied\n');
  const runDir = path.join(dreamPaths(env).runs, record.runId);
  assert.deepEqual(execFileSync('ls', [runDir], { encoding: 'utf8' }).split('\n').filter((name) => name.startsWith('index-')), []);
});

test('two roots that are the same place keep the first and name the second as skipped', async (t) => {
  const { record } = await branchRun(t, {
    setup({ repo, dir }) { symlinkSync(path.join(repo, 'docs'), path.join(dir, 'docs-link')); },
    roots: (repo, dir) => [{ path: path.join(repo, 'docs'), mode: 'branch' }, { path: path.join(dir, 'docs-link'), mode: 'report' }],
  });
  assert.equal(record.status, 'partial');
  assert.match(record.skipped[0].reason, /same place/);
});

test('files are stored with the base commit\'s attributes, and attributes, nested repositories and a locked root are never published', async (t) => {
  // A clean filter from the base commit's attributes: what is stored is upper case.
  const filtered = await branchRun(t, {
    setup({ repo }) {
      git(repo, 'config', 'filter.upper.clean', 'tr a-z A-Z');
      git(repo, 'config', 'filter.upper.smudge', 'cat');
      put(path.join(repo, '.gitattributes'), 'docs/*.md filter=upper\n');
      git(repo, 'add', '.gitattributes');
      git(repo, 'commit', '--quiet', '-m', 'filter');
    },
    work({ worktree }) {
      writeFileSync(path.join(worktree, '.gitattributes'), '');
      writeFileSync(path.join(worktree, 'docs', '.gitattributes'), '*.md -filter\n');
      writeFileSync(path.join(worktree, 'docs', 'copy.md'), 'see runbook\n');
      execFileSync('git', ['init', '--quiet', path.join(worktree, 'docs', 'scratch')]);
      put(path.join(worktree, 'docs', 'scratch', 'note.md'), 'scratch\n');
      git(path.join(worktree, 'docs', 'scratch'), 'add', '.');
      git(path.join(worktree, 'docs', 'scratch'), 'commit', '--quiet', '-m', 'scratch');
    },
  });
  const branch = filtered.record.branches[0].branch;
  assert.equal(git(filtered.repo, 'show', `${branch}:docs/copy.md`), 'SEE RUNBOOK\n');
  assert.deepEqual(git(filtered.repo, 'show', '--name-only', '--format=', branch).trim().split('\n'), ['docs/copy.md']);
  assert.deepEqual(filtered.record.reverted.map((item) => `${item.path}:${item.reason}`),
    ['.gitattributes:outside the roots', 'docs/.gitattributes:attributes', 'docs/scratch:nested repository']);

  if (darwin) {
    const rootLocked = await branchRun(t, {
      setup({ repo }) { execFileSync('chflags', ['uchg', repo]); },
      roots: (repo) => [{ path: repo, mode: 'branch' }],
      work({ plan }) {
        execFileSync('chflags', ['nouchg', plan.roots[0].work]);
        writeFileSync(path.join(plan.roots[0].work, 'new.md'), 'new\n');
      },
    });
    assert.deepEqual(rootLocked.record.branches, []);
    assert.deepEqual(rootLocked.record.reverted.map((item) => `${item.path}:${item.reason}`), ['new.md:locked']);
    execFileSync('chflags', ['nouchg', rootLocked.repo]);
  }
});

test('a root that is only in the user\'s checkout is skipped and does not cost another root its edit', async (t) => {
  const { record, repo } = await branchRun(t, {
    setup({ repo }) { put(path.join(repo, 'personal.md'), 'not committed\n'); },
    roots: (repo) => [{ path: path.join(repo, 'docs'), mode: 'branch' }, { path: path.join(repo, 'personal.md'), mode: 'branch' }],
    work({ worktree }) { writeFileSync(path.join(worktree, 'docs', 'copy.md'), 'See runbook.\n'); },
  });
  assert.match(record.skipped[0].reason, /last commit/);
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', record.branches[0].branch).trim().split('\n'), ['docs/copy.md']);
});

test('a change to the repository\'s own settings is named as a change to the source', async (t) => {
  const { record } = await branchRun(t, { work({ repo }) { git(repo, 'config', 'core.hooksPath', '/tmp/elsewhere'); } });
  assert.equal(record.sourceChanged.length, 1);
});

test('a file the repository ignores is left out and does not fail the run', async (t) => {
  const { record, repo } = await branchRun(t, {
    setup({ repo }) { put(path.join(repo, '.gitignore'), '*.log\n'); git(repo, 'add', '.gitignore'); git(repo, 'commit', '--quiet', '-m', 'ignore'); },
    work({ worktree }) {
      writeFileSync(path.join(worktree, 'docs', 'scan.log'), 'scratch output\n');
      writeFileSync(path.join(worktree, 'docs', 'copy.md'), 'See runbook.\n');
    },
  });
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', record.branches[0].branch).trim().split('\n'), ['docs/copy.md']);
});

test('a case-only rename, a tracked file under node_modules, a folder turned link and an empty nested repository each keep the sibling edit', async (t) => {
  const { record, repo } = await branchRun(t, {
    setup({ repo }) {
      put(path.join(repo, 'docs', 'node_modules', 'guide.md'), 'tracked here on purpose\n');
      put(path.join(repo, 'docs', 'sub', 'file.md'), 'inside\n');
      git(repo, 'add', '-f', '.');
      git(repo, 'commit', '--quiet', '-m', 'more docs');
    },
    work({ worktree, dir }) {
      git(worktree, 'mv', 'docs/runbook.md', 'docs/RUNBOOK.md');
      writeFileSync(path.join(worktree, 'docs', 'node_modules', 'guide.md'), 'tidied\n');
      put(path.join(dir, 'outside', 'file.md'), 'outside bytes\n');
      rmSync(path.join(worktree, 'docs', 'sub'), { recursive: true });
      symlinkSync(path.join(dir, 'outside'), path.join(worktree, 'docs', 'sub'));
      execFileSync('git', ['init', '--quiet', path.join(worktree, 'docs', 'temp')]);
      put(path.join(worktree, 'docs', 'temp', 'draft.md'), 'draft\n');
      writeFileSync(path.join(worktree, 'docs', 'copy.md'), 'See runbook.\n');
    },
  });
  const branch = record.branches[0].branch;
  const names = git(repo, 'show', '--name-status', '--no-renames', '--format=', branch).trim().split('\n').sort();
  assert.deepEqual(names, ['A\tdocs/RUNBOOK.md', 'D\tdocs/runbook.md', 'M\tdocs/copy.md', 'M\tdocs/node_modules/guide.md'].sort());
  assert.equal(git(repo, 'show', `${branch}:docs/sub/file.md`), 'inside\n');
  assert.deepEqual(record.reverted.map((item) => `${item.path}:${item.reason}`).sort(), ['docs/sub:link', 'docs/temp:nested repository']);
});

test('a nested repository made inside a tracked folder takes nothing of that folder with it', async (t) => {
  const { record, repo } = await branchRun(t, {
    setup({ repo }) { put(path.join(repo, 'docs', 'sub', 'file.md'), 'inside\n'); git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'sub'); },
    work({ worktree }) {
      execFileSync('git', ['init', '--quiet', path.join(worktree, 'docs', 'sub')]);
      writeFileSync(path.join(worktree, 'docs', 'copy.md'), 'See runbook.\n');
    },
  });
  const branch = record.branches[0].branch;
  assert.deepEqual(git(repo, 'show', '--name-status', '--no-renames', '--format=', branch).trim().split('\n'), ['M\tdocs/copy.md']);
  assert.equal(git(repo, 'show', `${branch}:docs/sub/file.md`), 'inside\n');
});

test('a locked file under node_modules is locked like any other', { skip: !darwin }, async (t) => {
  const { record, repo } = await branchRun(t, {
    setup({ repo }) {
      put(path.join(repo, 'docs', 'node_modules', 'guide.md'), 'locked guide\n');
      git(repo, 'add', '-f', '.');
      git(repo, 'commit', '--quiet', '-m', 'guide');
      execFileSync('chflags', ['uchg', path.join(repo, 'docs', 'node_modules', 'guide.md')]);
    },
    work({ worktree }) {
      const guide = path.join(worktree, 'docs', 'node_modules', 'guide.md');
      execFileSync('chflags', ['nouchg', guide]);
      writeFileSync(guide, 'changed\n');
    },
  });
  assert.deepEqual(record.branches, []);
  assert.deepEqual(record.reverted.map((item) => `${item.path}:${item.reason}`), ['docs/node_modules/guide.md:locked']);
  execFileSync('chflags', ['nouchg', path.join(repo, 'docs', 'node_modules', 'guide.md')]);
});

test('a companion\'s own dream models come first, then the user\'s memory.dream.models, then Rubato\'s own; the global file is only read', async (t) => {
  const { dir, env } = sandbox(t);
  const configFile = put(path.join(dir, '.rubato', 'rubato.jsonc'), '{ "memory": { "dream": { "models": [ { "model": "xai/grok-4.7", "reasoning": "medium" } ] } } }\n');
  const before = readFileSync(configFile, 'utf8');
  assert.deepEqual(await resolveModels(env), [{ model: 'xai/grok-4.7', thinking: 'medium' }], 'no own models: the global ladder');
  writeSettings({ dream: { models: [{ model: 'anthropic/claude-opus-5-5', reasoning: 'high' }, 'opengateway/deepseek/deepseek-v4.1-flash-eco'] } }, env);
  assert.deepEqual(await resolveModels(env), [{ model: 'anthropic/claude-opus-5-5', thinking: 'high' }, { model: 'opengateway/deepseek/deepseek-v4.1-flash-eco' }]);
  // Its own ladder stands even when the global file is broken: that file is not read then.
  writeFileSync(configFile, '{ "memory": ');
  const errors = [];
  assert.equal((await resolveModels(env, (error) => errors.push(error)))[0].model, 'anthropic/claude-opus-5-5');
  assert.deepEqual(errors, []);
  writeSettings({ dream: { models: [] } }, env);
  assert.equal(await resolveModels(env, () => {}), DREAM_MODELS, 'none of its own and a broken global file: Rubato\'s own');
  writeFileSync(configFile, before);
  assert.equal(readFileSync(configFile, 'utf8'), before, 'the global config is untouched');
  // Another companion's home has its own settings: one companion's ladder is not another's.
  const other = { ...env, RUBATO_COMPANION_HOME: path.join(dir, 'other-companion') };
  writeSettings({ dream: { models: ['anthropic/claude-sonnet-5-5'] } }, other);
  assert.deepEqual(await resolveModels(env), [{ model: 'xai/grok-4.7', thinking: 'medium' }]);
  assert.deepEqual(await resolveModels(other), [{ model: 'anthropic/claude-sonnet-5-5' }]);
});

test('the companion\'s dream models are set by talking or on the Settings page, through the same checks', async (t) => {
  const { dir, env } = sandbox(t);
  const sessionsDir = path.join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeState({ sessionId: 'S1' }, env);
  writeFileSync(path.join(sessionsDir, '2026-10-20T00-00-00-000Z_S1.jsonl'), `${JSON.stringify(appEntry('u1', '꿈 모델은 오퍼스 먼저, 안 되면 그록'))}\n`);
  const service = createCompanionService({ env, defaultsDir, telegram: false });
  const call = (request) => companionSettings({ sessionId: 'S1', sessionsDir, env, service, request, telegram: false });
  const models = [{ model: 'anthropic/claude-opus-5-5', reasoning: 'high' }, { model: 'xai/grok-4.7' }];
  const answer = await call({ action: 'change', change: { companion: { dream: { models } } } });
  assert.deepEqual(answer.settings.companion.dream.models, models);
  assert.deepEqual((await service.handle('status', {})).settings.dream.models, models, 'the page shows what the talk set');
  await service.handle('save-settings', { patch: { dream: { models: [...models].reverse() } } });
  assert.deepEqual((await call({ action: 'show' })).settings.companion.dream.models, [...models].reverse(), 'the companion sees the page\'s order');
  assert.deepEqual(readSettings(env).dream.docs, DEFAULT_SETTINGS.dream.docs, 'its docs settings stay as they were');
  for (const bad of [['opus'], [{ model: 'xai/grok-4.7', reasoning: 'loud' }], ['xai/grok-4.7', 'xai/grok-4.7'], [{ model: 'xai/grok-4.7', temperature: 1 }],
    Array.from({ length: 9 }, (_, index) => `xai/m${index}`)]) {
    await assert.rejects(call({ action: 'change', change: { companion: { dream: { models: bad } } } }), (error) => error.code === 'invalid', JSON.stringify(bad));
  }
  assert.deepEqual(DREAM_REASONING_LEVELS, [...REASONING_LEVELS], 'the levels a companion may name are config-core\'s');
});
