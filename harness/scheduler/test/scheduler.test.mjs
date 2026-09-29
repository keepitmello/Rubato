import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startSessionServer } from '../../pi-server/src/host.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { isTitleLocked } from '../../pi-runtime/features/session-title/session-title.mjs';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { createEngineConnector } from '../src/engine.mjs';
import { createScheduler } from '../src/scheduler.mjs';

// End to end below the model: a real Pi server on a Unix socket, its session router and
// JSONL files, the real engine connector reading a real descriptor, the real store and
// scheduler. Only the model is the deterministic fixture child.
const fixture = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));
const until = async (predicate, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > deadline) throw new Error('Condition did not settle'); await delay(25); }
};

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sched-'));
  const agentDir = path.join(root, 'agent');
  const project = path.join(root, 'project');
  await mkdir(path.join(agentDir, 'server'), { recursive: true });
  await mkdir(project);
  const socketPath = path.join(root, 'pi.sock');
  const service = await startSessionServer({ socketPath, sessionsDir: path.join(agentDir, 'sessions'), idleMs: 200, pollMs: 50,
    workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: fixture }) });
  await writeFile(path.join(agentDir, 'server', 'connection.json'), JSON.stringify({ version: 1, serverId: service.serverId, socketPath }));
  const clock = { value: new Date('2026-09-29T00:00:00Z') }; // 09:00 in Seoul; the tests pin TZ below
  const store = createScheduleStore({ root: path.join(root, 'schedule'), now: () => clock.value });
  const logs = [];
  const engine = createEngineConnector({ agentDir });
  const schedulers = [];
  const scheduler = (options = {}) => {
    const instance = createScheduler({ store, engine, now: () => clock.value, tickMs: 60_000, log: (...entry) => logs.push(entry),
      runOptions: { quietMs: 300, pollMs: 50 }, reconcileWaitMs: 2000, ...options });
    schedulers.push(instance);
    return instance;
  };
  t.after(async () => {
    for (const instance of schedulers) await instance.stop();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, agentDir, project, service, store, clock, scheduler, logs, engine };
}
const settled = (store, taskId) => until(async () => {
  const { runs } = await store.runs(taskId);
  return runs.length && runs.every((run) => run.status !== 'running') ? runs : undefined;
}).catch(async (error) => { throw new Error(`${error.message}: ${JSON.stringify((await store.runs(taskId)).runs)}`); });
const sessionEntries = async (service, sessionId) => {
  const file = (await service.host.resolveSession(sessionId)).file;
  return (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
};

/** The run's session is mid-turn in the engine (its prompt was sent). */
async function streaming(env, sessionId) {
  const client = await env.engine.connect();
  try {
    const entry = (await client.list()).find((item) => item.sessionId === sessionId);
    if (entry?.status !== 'running') return false;
    await client.attach(sessionId);
    return (await client.command({ type: 'get_state' })).isStreaming === true;
  } finally { await client.close(); }
}

process.env.TZ = 'Asia/Seoul';

test('a due task starts an ordinary saved session with the scheduled title and records success', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-28T23:59:00Z'); // 08:59
  const task = await env.store.create({ name: 'Morning research', cwd: env.project, prompt: 'Summarize issues',
    model: 'fixture/other', schedule: { kind: 'daily', time: '09:00' } });
  const scheduler = env.scheduler();
  await scheduler.start();
  assert.equal((await env.store.runs(task.id)).runs.length, 0, 'nothing is due at 08:59');
  env.clock.value = new Date('2026-09-29T00:00:04Z'); // 09:00:04
  await scheduler.tick();
  const [run] = await settled(env.store, task.id);
  assert.equal(run.status, 'success', JSON.stringify(run));
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.scheduledFor, '2026-09-29T00:00:00.000Z');
  assert.equal(run.model, 'fixture/other');
  assert.equal(run.title, '⏰ Morning research · 9/29 09:00');
  assert.equal(run.serverId, env.service.serverId);
  assert.ok(run.startedAt && run.finishedAt);
  // The session is an ordinary stored conversation with that title, in the task's folder.
  const listed = (await env.service.host.resolveSession(run.sessionId));
  assert.equal(listed.title, '⏰ Morning research · 9/29 09:00');
  assert.equal(listed.cwd, await (await import('node:fs/promises')).realpath(env.project));
  const entries = await sessionEntries(env.service, run.sessionId);
  assert.equal(isTitleLocked(entries), true);
  const texts = entries.filter((entry) => entry.type === 'message').map((entry) => entry.message.role);
  assert.deepEqual(texts, ['user', 'assistant']);
  // The next day's run is next.
  assert.equal((await env.store.get(task.id)).nextRunAt, '2026-09-30T00:00:00.000Z');
});

test('a turn error is a failure that keeps the session link; a missing folder fails before any session', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-28T23:59:00Z');
  const failing = await env.store.create({ name: 'Fails', cwd: env.project, prompt: 'fail', schedule: { kind: 'daily', time: '09:00' } });
  const gone = path.join(env.root, 'gone');
  await mkdir(gone);
  const orphan = await env.store.create({ name: 'Orphan', cwd: gone, prompt: 'hi', schedule: { kind: 'daily', time: '09:00' } });
  const badModel = await env.store.create({ name: 'Bad model', cwd: env.project, prompt: 'hi', model: 'nope/missing', schedule: { kind: 'daily', time: '09:00' } });
  await rm(gone, { recursive: true });
  const scheduler = env.scheduler();
  await scheduler.start();
  env.clock.value = new Date('2026-09-29T00:01:00Z');
  await scheduler.tick();
  const [turn] = await settled(env.store, failing.id);
  assert.deepEqual([turn.status, turn.reason, turn.detail], ['failed', 'turn-error', '401 invalid credentials']);
  assert.ok(turn.sessionId);
  const [missing] = await settled(env.store, orphan.id);
  assert.deepEqual([missing.status, missing.reason, missing.sessionId], ['failed', 'cwd-missing', null]);
  const [model] = await settled(env.store, badModel.id);
  assert.deepEqual([model.status, model.reason], ['failed', 'model']);
  assert.match(model.detail, /nope\/missing/);
  assert.ok(model.sessionId, 'the session existed before the model was refused');
});

test('missed times are recorded as one collapsed skip, never caught up, and can be run now', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-28T15:30:00Z'); // 00:30 Seoul
  const task = await env.store.create({ name: 'Hourly', cwd: env.project, prompt: 'check', schedule: { kind: 'interval', everyHours: 2 } });
  const scheduler = env.scheduler();
  await scheduler.start();
  // The scheduler was alive, and its clock next reads 07:40: the Mac slept through 02:00–06:00.
  env.clock.value = new Date('2026-09-28T22:40:00Z');
  await scheduler.tick();
  let { runs } = await env.store.runs(task.id);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].status, runs[0].reason, runs[0].skipCount], ['skipped', 'sleep', 3]);
  assert.equal(new Date(runs[0].scheduledFor).getHours(), 2);
  assert.equal(new Date(runs[0].lastScheduledFor).getHours(), 6);
  assert.equal(runs[0].sessionId, null);
  assert.equal(scheduler.inflight.size, 0, 'nothing was caught up');
  // Run now from the skip row.
  await env.store.runNow(task.id, { fromRunId: runs[0].id });
  await scheduler.tick();
  runs = await settled(env.store, task.id);
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[0].trigger, runs[0].status, runs[0].scheduledFor, runs[0].rerunOf], ['manual', 'success', null, runs[1].id]);
  // A scheduler that started after the missed time cannot tell sleep from power-off.
  await scheduler.stop();
  env.clock.value = new Date('2026-09-29T03:30:00Z'); // 12:30: 08:00, 10:00, 12:00 missed while no scheduler ran
  const cold = env.scheduler();
  await cold.start();
  ({ runs } = await env.store.runs(task.id));
  assert.deepEqual([runs[0].status, runs[0].reason, runs[0].skipCount], ['skipped', 'not-running', 3]);
});

test('a due time while the previous run is still going is skipped as overlap', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-28T22:59:00Z'); // 07:59
  const task = await env.store.create({ name: 'Slow', cwd: env.project, prompt: 'hang', schedule: { kind: 'interval', everyHours: 1 } });
  const scheduler = env.scheduler();
  await scheduler.start();
  env.clock.value = new Date('2026-09-28T23:00:01Z'); // 08:00
  await scheduler.tick();
  await until(async () => {
    const sessionId = (await env.store.runs(task.id)).runs[0]?.sessionId;
    return sessionId && await streaming(env, sessionId);
  });
  env.clock.value = new Date('2026-09-29T00:00:02Z'); // 09:00, still running
  await scheduler.tick();
  env.clock.value = new Date('2026-09-29T01:00:02Z'); // 10:00, still running
  await scheduler.tick();
  const { runs } = await env.store.runs(task.id);
  assert.deepEqual(runs.map((run) => [run.status, run.reason, run.skipCount]), [['skipped', 'overlap', 2], ['running', null, 0]]);
  await assert.rejects(env.store.runNow(task.id), (error) => error.code === 'already-running');
  // Stop the hung turn from another client, as a user in the T3 thread would.
  const client = await env.engine.connect();
  await client.attach(runs[1].sessionId);
  await client.command({ type: 'abort' });
  await client.close();
  const finished = await settled(env.store, task.id);
  assert.deepEqual([finished[1].status, finished[1].reason], ['failed', 'aborted']);
});

test('a once-task runs once and switches itself off', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-29T05:00:00Z'); // 14:00
  const task = await env.store.create({ name: 'Once', cwd: env.project, prompt: 'hi', schedule: { kind: 'once', date: '2026-09-29', time: '15:00' } });
  const scheduler = env.scheduler();
  await scheduler.start();
  env.clock.value = new Date('2026-09-29T06:00:30Z');
  await scheduler.tick();
  const [run] = await settled(env.store, task.id);
  assert.equal(run.status, 'success', JSON.stringify(run));
  const view = await env.store.get(task.id);
  assert.deepEqual([view.enabled, view.nextRunAt], [false, null]);
  env.clock.value = new Date('2026-09-30T06:00:30Z');
  await scheduler.tick();
  assert.equal((await env.store.runs(task.id)).runs.length, 1);
});

test('a restarted scheduler finishes watching a run the previous one started', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-28T23:59:00Z');
  const task = await env.store.create({ name: 'Question', cwd: env.project, prompt: 'question', schedule: { kind: 'daily', time: '09:00' } });
  const first = env.scheduler();
  await first.start();
  env.clock.value = new Date('2026-09-29T00:00:03Z');
  await first.tick();
  const pending = await until(async () => {
    const [run] = (await env.store.runs(task.id)).runs;
    return run?.sessionId && await streaming(env, run.sessionId) ? run : undefined;
  });
  await delay(200); // the fixture asks its question 30 ms after the turn starts
  await first.stop();
  assert.equal((await env.store.runs(task.id)).runs[0].status, 'running', 'a waiting question keeps the run in progress');
  // Rows the old process never got to: one without a session is marked interrupted.
  await env.store.mutate((state) => { state.runs.push({ ...pending, id: 'orphan', sessionId: null }); });
  const second = env.scheduler();
  await second.start();
  const client = await env.engine.connect();
  await client.attach(pending.sessionId);
  await client.reply({ id: 'q1', value: 'a' });
  await client.close();
  const runs = await settled(env.store, task.id);
  const byId = Object.fromEntries(runs.map((run) => [run.id, run]));
  assert.equal(byId[pending.id].status, 'success');
  assert.deepEqual([byId.orphan.status, byId.orphan.reason], ['failed', 'interrupted']);
});

test('an unreachable engine is a failure before any session', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-28T23:59:00Z');
  const task = await env.store.create({ name: 'No engine', cwd: env.project, prompt: 'hi', schedule: { kind: 'daily', time: '09:00' } });
  const scheduler = env.scheduler({ engine: { connect: async () => { throw new Error('connect ECONNREFUSED'); } } });
  await scheduler.start();
  env.clock.value = new Date('2026-09-29T00:00:03Z');
  await scheduler.tick();
  const [run] = await settled(env.store, task.id);
  assert.deepEqual([run.status, run.reason, run.sessionId], ['failed', 'engine-unavailable', null]);
});

test('a running row left while the engine was unreachable is picked up once the engine is back', async (t) => {
  const env = await setup(t);
  env.clock.value = new Date('2026-09-28T23:59:00Z'); // 08:59
  const task = await env.store.create({ name: 'Daily', cwd: env.project, prompt: 'hi', schedule: { kind: 'daily', time: '09:00' } });
  // A row a previous scheduler process left behind, for a session that already finished.
  const client = await env.engine.connect();
  const created = await client.create({ cwd: env.project, title: 'earlier run' });
  await client.attach(created.sessionId);
  await client.command({ type: 'prompt', message: 'earlier' });
  await delay(400);
  await client.close();
  await env.store.mutate((state) => {
    state.runs.push({ id: 'orphan', taskId: task.id, trigger: 'schedule', scheduledFor: '2026-09-28T00:00:00.000Z', lastScheduledFor: null,
      skipCount: 0, status: 'running', reason: null, detail: null, startedAt: '2026-09-28T00:00:01.000Z', finishedAt: null, model: null,
      thinking: null, cwd: env.project, sessionId: created.sessionId, serverId: env.service.serverId, title: null, rerunOf: null });
  });
  // The engine cannot be reached when this scheduler starts (an old engine still up, a slow boot).
  let down = true;
  const scheduler = env.scheduler({ engine: { connect: async () => { if (down) throw new Error('connect ECONNREFUSED'); return env.engine.connect(); } } });
  await scheduler.start();
  await until(() => scheduler.inflight.size === 0);
  assert.equal((await env.store.runs(task.id)).runs.find((run) => run.id === 'orphan').status, 'running');
  // The engine is back and the next tick is the one at the task's time: the row is settled
  // first, so the slot runs instead of being skipped as overlap.
  down = false;
  env.clock.value = new Date('2026-09-29T00:00:04Z');
  await scheduler.tick();
  const runs = await settled(env.store, task.id);
  assert.deepEqual(runs.map((run) => [run.trigger, run.status, run.reason]), [['schedule', 'success', null], ['schedule', 'success', null]]);
});
