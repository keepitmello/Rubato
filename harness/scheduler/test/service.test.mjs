import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { schedulerLockFile } from '../src/lock.mjs';

// The scheduler inside a real engine (the session server, socket and JSONL files are the real
// ones; the model child is the deterministic fixture): a due task starts a session there.
const agent = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));
const serviceModule = fileURLToPath(new URL('../src/service.mjs', import.meta.url));
const until = async (predicate, label, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > deadline) throw new Error(`timeout: ${label}`); await delay(50); }
};
const pad = (value) => String(value).padStart(2, '0');

async function engineWithScheduler(t, root, options = {}) {
  const previous = process.env.RUBATO_SCHEDULE_HOME;
  process.env.RUBATO_SCHEDULE_HOME = path.join(root, 'schedule');
  t.after(() => { if (previous === undefined) delete process.env.RUBATO_SCHEDULE_HOME; else process.env.RUBATO_SCHEDULE_HOME = previous; });
  const engine = await serveProfile({ agentDir: path.join(root, 'agent'), workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: agent }),
    onError: () => {}, resident: [{ name: 'scheduler', module: serviceModule, options: { tickMs: 200, ...options } }] });
  t.after(() => engine.close());
  return { engine, store: createScheduleStore({ root: path.join(root, 'schedule') }) };
}

test('the scheduler inside the engine runs a due task as a session of that engine, and run-now works', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await (await import('node:fs/promises')).mkdir(project);
  const { engine, store } = await engineWithScheduler(t, root);
  await until(() => store.schedulerStatus().running, 'scheduler beats');
  assert.equal(store.schedulerStatus().pid, process.pid, 'it beats from the engine process');
  // Due now: a daily time of this minute, judged from just before it.
  const now = new Date();
  if (now.getSeconds() > 50) await delay((61 - now.getSeconds()) * 1000);
  const at = new Date();
  const task = await store.create({ name: 'Due now', cwd: project, prompt: 'check things',
    schedule: { kind: 'daily', time: `${pad(at.getHours())}:${pad(at.getMinutes())}` } });
  const minute = new Date(at); minute.setSeconds(0, 0);
  await store.mutate((state) => { state.tasks.find((item) => item.id === task.id).evaluatedThrough = new Date(minute.getTime() - 1000).toISOString(); });
  const run = await until(async () => {
    const [latest] = (await store.runs(task.id)).runs;
    return latest?.status === 'success' ? latest : undefined;
  }, 'the due run succeeds');
  assert.deepEqual([run.trigger, run.serverId], ['schedule', engine.serverId]);
  assert.equal(run.scheduledFor, minute.toISOString());
  // Run now goes through the same store.
  await store.runNow(task.id);
  await until(async () => (await store.runs(task.id)).runs.some((item) => item.trigger === 'manual' && item.status === 'success'), 'run now succeeds');
});

test('while the old standalone scheduler holds the schedule, the engine\'s waits, then takes over', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A live process holding the lock, as the old launchd scheduler does until the update removes it.
  const holder = spawn('/bin/sleep', ['60']);
  t.after(() => holder.kill());
  await (await import('node:fs/promises')).mkdir(path.join(root, 'schedule'), { recursive: true });
  await writeFile(schedulerLockFile(path.join(root, 'schedule')), `${holder.pid}\n`);
  const { store } = await engineWithScheduler(t, root, { lockRetryMs: 200 });
  await delay(800);
  assert.equal(store.schedulerStatus().running, false, 'two schedulers never judge the same tasks');
  holder.kill();
  await until(() => store.schedulerStatus().running && store.schedulerStatus().pid === process.pid, 'the engine\'s scheduler takes over');
});
