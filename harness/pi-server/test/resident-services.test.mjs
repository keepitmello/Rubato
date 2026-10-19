import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { serveProfile } from '../src/profile-server.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { SessionClient } from '../src/client.mjs';
import { RESIDENT_SERVICES, startResidentServices } from '../src/resident-services.mjs';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';

// "다같이 죽는게 문제라면 애초에 안죽게 안전한 구조로" — a fault in any resident service must not stop
// the engine or a running conversation. These tests inject each kind of fault into each kind of
// service inside a real engine (the session server, socket and session files are the real ones;
// the model child is the scheduler's deterministic fixture) while a conversation runs a turn.

const agent = fileURLToPath(new URL('../../scheduler/test/fixtures/agent.mjs', import.meta.url));
const faultModule = fileURLToPath(new URL('./fixtures/resident/fault.mjs', import.meta.url));
const childModule = fileURLToPath(new URL('./fixtures/resident/child-service.mjs', import.meta.url));
const service = (name) => RESIDENT_SERVICES.find((entry) => entry.name === name).module;
const FAST = { restartMinMs: 50, restartMaxMs: 400, pingMs: 100, hungMs: 600, closeMs: 1500 };

const until = async (predicate, label, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await delay(25);
  }
};
const lines = async (file) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
// A child whose thread ended is reaped by no one, so it stays a zombie: ended, but kill(pid, 0) still finds it.
const alive = (pid) => {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
};

/** Sets process.env for the service threads (they copy it when they start) and restores it. */
function withEnv(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('a throw, a rejection, an exit, a self-kill, a hang or a failed start in a service thread restarts that service only, while a conversation keeps running', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-rs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const companionHome = path.join(root, 'companion');
  await mkdir(companionHome, { recursive: true });
  await writeFile(path.join(companionHome, 'settings.json'), JSON.stringify({ enabled: true, heartbeat: { enabled: false } }));
  withEnv(t, { RUBATO_COMPANION_HOME: companionHome, RUBATO_SCHEDULE_HOME: path.join(root, 'schedule') });
  const marker = (name) => path.join(root, `${name}.marker`);
  const faults = ['throw', 'reject', 'exit', 'kill', 'hang', 'start-throw'];
  const services = [
    ...faults.map((fault) => ({ name: `bare-${fault}`, module: faultModule, options: { fault, marker: marker(`bare-${fault}`) } })),
    // The real keeper and the real scheduler, each with a fault injected into its own thread.
    { name: 'companion', module: faultModule, options: { fault: 'throw', target: service('companion'), marker: marker('companion') } },
    { name: 'scheduler', module: faultModule, options: { fault: 'reject', target: service('scheduler'), marker: marker('scheduler') } },
  ];
  const errors = [];
  const engine = await serveProfile({ agentDir: path.join(root, 'agent'), workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: agent }),
    onError: (error) => errors.push(String(error?.message ?? error)), resident: services, residentTimings: FAST });
  t.after(() => engine.close());

  // A conversation runs a turn while every service fails.
  const client = await new SessionClient(engine.descriptor).connect();
  t.after(() => client.close());
  const created = await client.create({ cwd: root, title: 'Running' });
  await client.attach(created.sessionId);
  await client.command({ type: 'prompt', message: 'slow' });

  for (const { name } of services) {
    await until(async () => (await lines(marker(name))).filter((line) => line === 'start').length >= 2, `${name} started again`);
  }
  await until(() => engine.residents.status().every((item) => item.status === 'running'), 'every service running again');
  await until(async () => (await client.command({ type: 'get_state' })).isStreaming === false, 'the turn ends');
  const messages = (await client.command({ type: 'get_messages' })).messages;
  assert.equal(messages.at(-1).content[0].text, 'done: slow', 'the conversation finished its turn');
  assert.equal((await client.list()).find((item) => item.sessionId === created.sessionId)?.status !== undefined, true);

  // Each failure was reported with the service's name, and nothing else stopped.
  for (const fault of ['throw', 'reject', 'exit', 'kill', 'hang', 'start-throw']) {
    assert.ok(errors.some((line) => line.startsWith(`resident service bare-${fault}:`)), `bare-${fault} reported`);
  }
  assert.ok(errors.some((line) => /bare-exit: stopped \(exit 7\)/.test(line)));
  assert.ok(errors.some((line) => /bare-kill: .*process\.kill\(\d+, SIGKILL\) refused/s.test(line)));
  assert.ok(errors.some((line) => /bare-hang: did not answer/.test(line)));
  // The keeper is back on the same companion conversation; the scheduler beats again.
  const state = await until(async () => JSON.parse(await readFile(path.join(companionHome, 'state.json'), 'utf8').catch(() => 'null')), 'the keeper saved its conversation');
  assert.ok((await client.list()).some((item) => item.sessionId === state.sessionId), 'the companion conversation is kept');
  await until(() => createScheduleStore({ env: process.env }).schedulerStatus().running, 'the scheduler beats');
  assert.equal(createScheduleStore({ env: process.env }).schedulerStatus().pid, process.pid, 'the scheduler runs inside the engine');
});

test('a service that owns a child process: the child failing is the service\'s to restart, and the thread failing takes its child with it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-rc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = (name) => path.join(root, `${name}.marker`);
  const services = [
    ...['throw', 'reject', 'exit'].map((fault) => ({ name: `child-${fault}`, module: childModule, options: { childFault: fault, marker: marker(`child-${fault}`) } })),
    { name: 'thread-dies', module: childModule, options: { threadFault: 'throw', marker: marker('thread-dies') } },
  ];
  const errors = [];
  const engine = await serveProfile({ agentDir: path.join(root, 'agent'), workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: agent }),
    onError: (error) => errors.push(String(error?.message ?? error)), resident: services, residentTimings: FAST });
  t.after(() => engine.close());
  const client = await new SessionClient(engine.descriptor).connect();
  t.after(() => client.close());
  const created = await client.create({ cwd: root, title: 'Running' });
  await client.attach(created.sessionId);
  await client.command({ type: 'prompt', message: 'slow' });

  for (const fault of ['throw', 'reject', 'exit']) {
    const name = `child-${fault}`;
    const record = await until(async () => {
      const all = await lines(marker(name));
      return all.filter((line) => line.startsWith('child ')).length >= 2 ? all : undefined;
    }, `${name} child started again`);
    assert.match(record.find((line) => line.startsWith('child-exit')), fault === 'exit' ? /child-exit 9/ : /child-exit 1/);
  }
  // The thread that died left no child behind; its next start has a new one.
  const record = await until(async () => {
    const pids = (await lines(marker('thread-dies'))).filter((line) => line.startsWith('child ')).map((line) => Number(line.split(' ')[1]));
    return pids.length >= 2 ? pids : undefined;
  }, 'thread-dies started again');
  await until(() => !alive(record[0]), 'the first child ended with its thread');
  // Reaped, not left a zombie: the engine's main thread started it.
  await until(() => spawnSync('ps', ['-o', 'stat=', '-p', String(record[0])], { encoding: 'utf8' }).stdout.trim() === '', 'the first child is reaped');
  assert.equal(alive(record.at(-1)), true);
  assert.equal(engine.residents.status().find((item) => item.name === 'thread-dies').starts >= 2, true);
  await until(async () => (await client.command({ type: 'get_state' })).isStreaming === false, 'the turn ends');
  assert.equal((await client.command({ type: 'get_messages' })).messages.at(-1).content[0].text, 'done: slow');
  await engine.close();
  // Closing the engine closes each service, and the services end their children.
  await until(() => !alive(record.at(-1)), 'children end when the engine closes');
});

test('services reach the engine through host calls, the engine reaches them through call(), and close() does not wait forever', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-resident-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notices = [];
  const errors = [];
  const residents = startResidentServices({
    services: [{ name: 'plain', module: faultModule, options: { marker: path.join(root, 'plain.marker') } }],
    context: { agentDir: root, socketPath: path.join(root, 'none.sock'), serverId: 'test' },
    host: { notice: async (args) => { notices.push(args); return { delivered: true }; } },
    onError: (error) => errors.push(error.message), timings: { ...FAST, closeMs: 300 },
  });
  t.after(() => residents.close());
  await residents.ready;
  assert.equal(await residents.call('plain', 'starts'), 1);
  assert.deepEqual(await residents.call('plain', 'notice', { to: 'segno', text: 'hi' }), { delivered: true });
  assert.deepEqual(notices, [{ to: 'segno', text: 'hi' }]);
  await assert.rejects(residents.call('plain', 'close'), /has no method close/);
  await assert.rejects(residents.call('missing', 'starts'), /No resident service/);
  const started = Date.now();
  await residents.close();
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(await lines(path.join(root, 'plain.marker')), ['start', 'closed']);
  assert.equal(residents.status()[0].status, 'stopped');
});

test('a service that keeps failing backs off instead of spinning', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-resident-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const broken = path.join(root, 'broken.mjs');
  await writeFile(broken, 'export async function start() { throw new Error("always"); }\n');
  const residents = startResidentServices({ services: [{ name: 'broken', module: broken }],
    context: { agentDir: root, socketPath: path.join(root, 'none.sock'), serverId: 'test' }, onError: () => {},
    timings: { ...FAST, restartMinMs: 100, restartMaxMs: 800 } });
  t.after(() => residents.close());
  await delay(1500);
  const [state] = residents.status();
  // 100 + 200 + 400 + 800 ms: about four starts in 1.5 s, not hundreds.
  assert.ok(state.starts >= 3 && state.starts <= 6, `starts: ${state.starts}`);
  assert.equal(state.status, 'restarting');
});
