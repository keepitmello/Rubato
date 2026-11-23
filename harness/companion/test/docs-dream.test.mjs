// The dream's document upkeep (dream/docs.mjs): when it is due, what it may write and where, the
// settings that drive it, and how the companion hears about it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCompanionService } from '../../t3-integration/src/companion/service.mjs';
import { DEFAULT_SETTINGS, readSettings, writeSettings, writeState } from '../companion.mjs';
import { heartbeatText } from '../control-tower.mjs';
import { DOCS_CADENCE_HOURS, docsDue, docsReportLine, immutableFiles, runDocsDream } from '../dream/docs.mjs';
import { DREAM_MODELS, companionDreamModels, readDreamState, runCompanionDream } from '../dream/dream.mjs';
import { dreamNight } from '../dream/service.mjs';
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
  assert.deepEqual(shown.settings.companion.dream, { docs: { cadence: 'weekly', roots: [] } });
  const roots = [{ path: path.join(home, 'memory'), mode: 'edit' }, { path: '~/work/project/docs', mode: 'branch' }, { path: '/srv/money', mode: 'report' }];
  const answer = await call({ action: 'change', change: { companion: { dream: { docs: { roots, cadence: 'daily' } } } } });
  assert.deepEqual(answer.settings.companion.dream.docs, { cadence: 'daily', roots });
  assert.deepEqual((await service.handle('status', {})).settings.dream.docs, answer.settings.companion.dream.docs, 'the page shows what the talk set');

  // The page changes the cadence; the roots the companion set stay.
  await service.handle('save-settings', { patch: { dream: { docs: { cadence: 'monthly' } } } });
  assert.deepEqual(readSettings(env).dream.docs, { cadence: 'monthly', roots });

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
  assert.equal(state.blocks.docs.decide, 1);
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
  assert.deepEqual(record.sourceChanged.sort(), [path.join(dir, 'notes-folder'), repo].map((item) => execFileSync('realpath', [item], { encoding: 'utf8' }).trim()).sort());
  assert.match(readFileSync(record.report, 'utf8'), /확인 필요/);
  assert.deepEqual(record.branches, []);
  git(repo, 'checkout', '--quiet', '--', 'docs/runbook.md');

  const before = readDreamState(env).blocks.docs;
  const failing = await runDocsDream({ env, settings: readSettings(env), launch, manual: true, models: DREAM_MODELS, now: () => at(28, 4, 30),
    spawnChild: fakeTender({ code: 1 }).spawnChild, defaultsDir });
  assert.equal(failing.status, 'failed');
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

test('the companion dream runs on the dream ladder the user set, and on its own models when none is set', () => {
  const set = { layers: [{ config: { memory: { dream: { models: [{ model: 'xai/grok-4.7', reasoning: 'medium' }] } } } }],
    config: { memory: { dream: { models: [{ model: 'xai/grok-4.7', reasoning: 'medium' }] } } } };
  assert.deepEqual(companionDreamModels(set, dreamLadder), [{ model: 'xai/grok-4.7', thinking: 'medium' }]);
  // Unset in every layer: the schema's default ladder is not the user's choice, so the companion keeps its own.
  const unset = { layers: [{ config: { memory: { dream: { enabled: false } } } }],
    config: { memory: { dream: { models: [{ model: 'b-ai/deepseek-v4.1-flash', reasoning: 'medium' }] } } } };
  assert.equal(companionDreamModels(unset, dreamLadder), DREAM_MODELS);
  assert.equal(companionDreamModels({ layers: [{ config: { memory: { dream: { models: ['not-a-model'] } } } }], config: { memory: { dream: { models: ['not-a-model'] } } } }, dreamLadder),
    DREAM_MODELS, 'nothing launchable falls back');
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
