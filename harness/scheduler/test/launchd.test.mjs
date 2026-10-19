import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { engineJob, removeEngineLaunchAgent } from '../../pi-server/src/launchd.mjs';
import { startScheduler } from '../src/launchd.mjs';

const fakeLaunchd = fileURLToPath(new URL('../../pi-server/test/fixtures/fake-launchd.mjs', import.meta.url));

test('start scheduler registers the engine with launchd and returns once the scheduler inside it beats', async (t) => {
  // A short HOME: the engine's socket lives under it.
  const home = await mkdtemp('/tmp/rbsl-');
  const launchctl = path.join(home, 'launchctl');
  writeFileSync(launchctl, `#!/bin/sh\nFAKE_LAUNCHD_DIR="${path.join(home, 'launchd')}" exec "${process.execPath}" "${fakeLaunchd}" "$@"\n`, { mode: 0o755 });
  const env = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', RUBATO_LAUNCHCTL_BIN: launchctl, RUBATO_NODE: process.execPath,
    RUBATO_STOCK_ENGINE_DIR: path.join(home, 'no-engine'), RUBATO_SCHEDULE_HOME: path.join(home, 'schedule') };
  t.after(async () => {
    await removeEngineLaunchAgent({ env }).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  // An older install's scheduler job, which this replaces.
  const job = engineJob(env);
  spawnSync('mkdir', ['-p', job.agentsDir]);
  writeFileSync(job.legacySchedulerPlist, '<plist/>');
  const started = await startScheduler({ env, platform: 'darwin' });
  assert.equal(started.running, true);
  assert.equal(started.installed, true);
  assert.equal(existsSync(job.legacySchedulerPlist), false, 'the old scheduler job is removed');
  const store = createScheduleStore({ env });
  assert.equal(store.schedulerStatus().pid, started.pid);
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(started.pid)], { encoding: 'utf8' }).stdout;
  assert.match(command, /pi-server\/src\/cli\.mjs --agent-dir .* --launchd/, 'the scheduler runs inside the launchd engine');
  // Pressing it again while it runs registers nothing new.
  assert.deepEqual(await startScheduler({ env, platform: 'darwin' }), { running: true, pid: started.pid, installed: false });
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
