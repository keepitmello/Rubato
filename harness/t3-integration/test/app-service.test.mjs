// Settings > General > About's server half: the checkout's version, an update
// check (the rubato update --check call is injected; the rest is real git), and
// the restart handed to the one-shot updater, and that job's status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppService, handleAppRequest } from '../src/app/service.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

async function checkout(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-app-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const origin = path.join(home, 'origin');
  const root = path.join(home, 'rubato');
  execFileSync('git', ['init', '-q', '-b', 'rubato/base', origin]);
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'first');
  execFileSync('git', ['clone', '-q', origin, root]);
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'second: new thing');
  git(root, 'fetch', '-q');
  return { home, root };
}

test('version names the checkout commit and the pins', async (t) => {
  const f = await checkout(t);
  const version = await createAppService({ root: f.root, env: { ...process.env, HOME: f.home } }).handle('version');
  assert.equal(version.subject, 'first');
  assert.equal(version.branch, 'rubato/base');
  assert.equal(version.revision, git(f.root, 'rev-parse', 'HEAD'));
  assert.equal(version.localChanges, 0);
});

test('check lists what an available update brings', async (t) => {
  const f = await checkout(t);
  const service = createAppService({
    root: f.root, env: { ...process.env, HOME: f.home },
    checkForUpdate: async () => ({ available: true, revision: 'x', commits: 1 }),
  });
  const result = await service.handle('check');
  assert.equal(result.available, true);
  assert.deepEqual(result.changes.map((change) => change.subject), ['second: new thing']);
  const none = createAppService({ root: f.root, env: { ...process.env, HOME: f.home }, checkForUpdate: async () => ({ available: false }) });
  assert.deepEqual(await none.handle('check'), { available: false, commits: 0, changes: [] });
  const offline = createAppService({ root: f.root, env: { ...process.env, HOME: f.home }, checkForUpdate: async () => { throw new Error('offline'); } });
  await assert.rejects(offline.handle('check'), /offline/);
});

// The restart goes through the one-shot updater: `restart TOKEN APP_PID`, detached,
// without this server's ELECTRON_RUN_AS_NODE, which would reach the bundle rebuild.
test('restart hands `rubato restart` to the updater, detached and without Electron node mode', async (t) => {
  const f = await checkout(t);
  const seen = path.join(f.home, 'seen.json');
  const service = createAppService({
    root: f.root, appPid: 4242,
    env: { ...process.env, HOME: f.home, ELECTRON_RUN_AS_NODE: '1' },
    runner: [process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(1), env: process.env }))`],
  });
  const started = await service.handle('restart');
  assert.match(started.token, /^[a-f0-9-]{36}$/);
  assert.match(started.log, /gui-update\/update\.log$/);
  let ran = null;
  for (let i = 0; i < 100 && !ran; i += 1) {
    ran = JSON.parse(await readFile(seen, 'utf8').catch(() => 'null'));
    if (!ran) await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(ran.argv, ['restart', started.token, '4242']);
  assert.equal(ran.env.ELECTRON_RUN_AS_NODE, undefined);
  const response = await handleAppRequest(service, new Request('http://x/rubato/app/nope', { method: 'POST' }));
  assert.equal(response.status, 404);
});

test('restart is refused while an update or restart holds the updater', async (t) => {
  const f = await checkout(t);
  const directory = path.join(f.home, '.rubato-pi', 'gui-update');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'lock.json'), JSON.stringify({ pid: process.pid, token: 'x' }));
  const service = createAppService({ root: f.root, env: { ...process.env, HOME: f.home }, runner: ['/usr/bin/false'] });
  await assert.rejects(service.handle('restart'), /already running/);
  const status = await service.handle('restart-status');
  assert.equal(status.busy, true);
});

test('restart-status reports the job result the page waits for', async (t) => {
  const f = await checkout(t);
  const service = createAppService({ root: f.root, env: { ...process.env, HOME: f.home } });
  assert.deepEqual((await service.handle('restart-status')).result, null);
  const directory = path.join(f.home, '.rubato-pi', 'gui-update');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'result.json'),
    JSON.stringify({ token: 't1', kind: 'restart', status: 'failed', message: 'The restart did not finish (1). Check the log.' }));
  const status = await service.handle('restart-status');
  assert.equal(status.busy, false);
  assert.deepEqual(status.result, { token: 't1', kind: 'restart', status: 'failed', message: 'The restart did not finish (1). Check the log.' });
});
