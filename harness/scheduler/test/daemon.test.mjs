import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { main } from '../src/cli.mjs';

// The shipped processes: the fixture engine launcher starts the real daemon entry, and the
// CLI talks to the same store. Only the model child is a fixture.
const launcher = fileURLToPath(new URL('./fixtures/serve-fixture-engine.mjs', import.meta.url));
const until = async (predicate, ms = 20000) => {
  const deadline = Date.now() + ms;
  for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > deadline) throw new Error('Condition did not settle'); await delay(50); }
};

test('the daemon runs a task on "run now", and the CLI lists and starts tasks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sd-'));
  const child = spawn(process.execPath, [launcher, '--root', root, '--tick-ms', '60000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  const info = JSON.parse(await until(() => output.split('\n').find((line) => line.startsWith('{'))));
  const store = createScheduleStore({ root: info.scheduleHome });
  await until(() => store.schedulerStatus().running);
  const project = await mkdtemp(path.join(tmpdir(), 'sd-project-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const task = await store.create({ name: 'Nightly check', cwd: project, prompt: 'check things', schedule: { kind: 'daily', time: '03:00' } });

  let printed = '';
  const env = { ...process.env, RUBATO_SCHEDULE_HOME: info.scheduleHome };
  assert.equal(await main(['list'], { env, out: (text) => { printed += text; } }), 0);
  assert.match(printed, /Nightly check/);
  assert.match(printed, /Every day at 3:00 AM/);
  assert.doesNotMatch(printed, /scheduler is not running/);

  printed = '';
  assert.equal(await main(['run', 'nightly'], { env, out: (text) => { printed += text; } }), 0);
  const run = await until(async () => {
    const [latest] = (await store.runs(task.id)).runs;
    return latest?.status === 'success' ? latest : undefined;
  });
  assert.deepEqual([run.trigger, run.scheduledFor, run.serverId], ['manual', null, info.serverId]);
  assert.match(run.title, /^⏰ Nightly check · /);

  printed = '';
  assert.equal(await main(['runs', task.id.slice(0, 8), '--json'], { env, out: (text) => { printed += text; } }), 0);
  assert.equal(JSON.parse(printed).runs[0].sessionId, run.sessionId);

  // A second daemon on the same schedule waits instead of judging the tasks twice.
  const second = spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.mjs', import.meta.url)), '--root', info.scheduleHome,
    '--agent-dir', info.agentDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let secondOut = '';
  second.stdout.on('data', (data) => { secondOut += data; });
  await until(() => /another scheduler holds this schedule/.test(secondOut));
  second.kill('SIGTERM');
  await new Promise((resolve) => second.once('exit', resolve));
  assert.equal(store.schedulerStatus().pid, info.daemonPid);

  // Stopping the scheduler is visible to every client.
  // (The Pi server's own signal handling ends the launcher; the daemon stops on its SIGTERM.)
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await until(() => !store.schedulerStatus().running);
  await assert.rejects(store.runNow(task.id), (error) => error.code === 'scheduler-offline');
});

test('the CLI refuses an unknown or ambiguous task by name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sd-cli-'));
  const project = await mkdtemp(path.join(tmpdir(), 'sd-cli-project-'));
  try {
    const store = createScheduleStore({ root });
    await store.create({ name: 'Report A', cwd: project, prompt: 'a', schedule: { kind: 'daily', time: '09:00' } });
    await store.create({ name: 'Report B', cwd: project, prompt: 'b', schedule: { kind: 'daily', time: '09:00' } });
    await assert.rejects(main(['run', 'report'], { store, out: () => {} }), /matches 2 tasks/);
    await assert.rejects(main(['run', 'nothing'], { store, out: () => {} }), (error) => error.code === 'not-found');
  } finally { await rm(root, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); }
});
