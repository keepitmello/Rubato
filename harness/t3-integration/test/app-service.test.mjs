// Settings > General > About's server half: the checkout's version, an update
// check (the rubato update --check call is injected; the rest is real git), and
// a detached restart that refuses to start twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('restart runs `rubato restart` detached, once', async (t) => {
  const f = await checkout(t);
  const marker = path.join(f.home, 'ran');
  const service = createAppService({
    root: f.root, env: { ...process.env, HOME: f.home },
    rubato: ['/bin/sh', '-c', `echo "$1" > '${marker}'`, 'rubato'],
  });
  const started = await service.handle('restart');
  assert.match(started.log, /rubato-restart-gui\.log$/);
  for (let i = 0; i < 50 && !(await readFile(marker, 'utf8').catch(() => '')); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await readFile(marker, 'utf8')).trim(), 'restart');
  await assert.rejects(service.handle('restart'), /already running/);
  const response = await handleAppRequest(service, new Request('http://x/rubato/app/nope', { method: 'POST' }));
  assert.equal(response.status, 404);
});
