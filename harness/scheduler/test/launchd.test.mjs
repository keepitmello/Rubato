import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { renderSchedulerLaunchAgent, startScheduler } from '../src/launchd.mjs';

const fakeLaunchctl = fileURLToPath(new URL('./fixtures/fake-launchctl.mjs', import.meta.url));

test('start scheduler registers the launchd job for this checkout and returns once the daemon beats', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'sl-'));
  const trace = path.join(home, 'launchctl.trace');
  // launchctl is called with the caller's env; a Dock PATH has no node, so name it.
  const launchctl = path.join(home, 'launchctl');
  writeFileSync(launchctl, `#!/bin/sh\nexec "${process.execPath}" "${fakeLaunchctl}" "$@"\n`, { mode: 0o755 });
  const env = { HOME: home, PATH: '/usr/bin:/bin', RUBATO_LAUNCHCTL_BIN: launchctl, FAKE_LAUNCHCTL_TRACE: trace,
    RUBATO_SCHEDULE_HOME: path.join(home, 'schedule'), RUBATO_NODE: process.execPath };
  t.after(async () => {
    try { process.kill(Number(readFileSync(`${trace}.pid`, 'utf8')), 'SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(home, { recursive: true, force: true });
  });
  const started = await startScheduler({ env, platform: 'darwin' });
  assert.equal(started.running, true);
  assert.equal(started.installed, true);
  const store = createScheduleStore({ env });
  assert.equal(store.schedulerStatus().pid, started.pid);
  const plist = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.keepitmello.rubato.scheduler.plist'), 'utf8');
  assert.match(plist, /harness\/scheduler\/src\/daemon\.mjs/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, new RegExp(`<key>RUBATO_SCHEDULE_HOME</key><string>${env.RUBATO_SCHEDULE_HOME}</string>`));
  // A Dock-launched app has PATH=/usr/bin:/bin; the job still gets Node's folder and the usual tool places.
  assert.match(plist, new RegExp(path.dirname(process.execPath).replaceAll('/', '\\/')));
  assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n').map((line) => line.split(' ')[0]),
    ['bootout', 'bootstrap', 'enable', 'kickstart']);
  // Pressing it again while it runs does nothing.
  assert.deepEqual(await startScheduler({ env, platform: 'darwin' }), { running: true, pid: started.pid, installed: false });
  assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 4);
});

test('start scheduler refuses off macOS and from a HOME that is not the account', async () => {
  await assert.rejects(startScheduler({ env: { HOME: tmpdir() }, platform: 'linux' }), (error) => error.code === 'unsupported-platform');
  const home = await mkdtemp(path.join(tmpdir(), 'sl-'));
  try {
    await assert.rejects(startScheduler({ env: { HOME: home }, platform: 'darwin' }), (error) => error.code === 'scheduler-start-failed');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a failing launchctl is reported, not waited out', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'sl-'));
  try {
    const started = Date.now();
    await assert.rejects(startScheduler({ env: { HOME: home, RUBATO_LAUNCHCTL_BIN: '/usr/bin/false', RUBATO_NODE: process.execPath }, platform: 'darwin' }),
      (error) => error.code === 'scheduler-start-failed' && /launchd/.test(error.message));
    assert.ok(Date.now() - started < 5000);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the plist escapes paths', () => {
  const plist = renderSchedulerLaunchAgent({ nodePath: '/a&b/node', home: '/h', pathEnv: '/x', logPath: '/l<og>' });
  assert.match(plist, /\/a&amp;b\/node/);
  assert.match(plist, /\/l&lt;og&gt;/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
});
