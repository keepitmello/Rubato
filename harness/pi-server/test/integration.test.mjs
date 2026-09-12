import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionFiles } from '../src/session-files.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { startSessionServer } from '../src/host.mjs';
import { SessionClient } from '../src/client.mjs';

const fixture = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
const until = async (predicate) => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(10); } throw new Error('Condition did not settle'); };
async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-'));
  const sessionsDir = path.join(root, 'sessions');
  const socketPath = path.join(root, 'pi.sock');
  const errors = [];
  const service = await startSessionServer({ socketPath, sessionsDir, idleMs: 70, pollMs: 50,
    workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: fixture }), onError: (error) => errors.push(error), ...options });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((client) => client.close())); await service.close(); await rm(root, { force: true, recursive: true }); });
  const client = async () => { const instance = await new SessionClient({ socketPath, serverId: service.serverId, onError: (error) => errors.push(error) }).connect(); clients.push(instance); return instance; };
  return { ...service, root, sessionsDir, socketPath, client, errors };
}

test('stored list does not hydrate 100 sessions; missing ID never creates a session', async (t) => {
  const env = await setup(t);
  const files = new SessionFiles(env.sessionsDir);
  await Promise.all(Array.from({ length: 100 }, (_, i) => files.create({ cwd: env.root, title: String(i) })));
  const client = await env.client();
  assert.equal((await client.list()).length, 100);
  assert.equal(env.host.metrics.runtimeStarts, 0);
  await assert.rejects(client.attach('absent'), /not found/i);
  assert.equal((await client.list()).length, 100);
});

test('running A survives detach, B interaction, concurrent reattach, and reconnect', async (t) => {
  const env = await setup(t);
  const client = await env.client();
  const peer = await env.client();
  const a = await client.create({ cwd: env.root, title: 'A' });
  const b = await client.create({ cwd: env.root, title: 'B' });
  await client.attach(a.sessionId);
  const original = await client.snapshot();
  const states = [];
  const unsubscribe = await client.subscribeSession((state) => states.push(state));
  await client.command({ type: 'prompt', message: 'background' });
  await until(() => states.some((state) => state.status === 'running'));
  await unsubscribe();
  await client.detach();
  await client.attach(b.sessionId);
  await client.command({ type: 'prompt', message: 'parallel' });
  await client.detach();
  await delay(100);
  await Promise.all([client.attach(a.sessionId), peer.attach(a.sessionId)]);
  assert.equal((await client.snapshot()).runtimeId, original.runtimeId);
  assert.equal((await peer.snapshot()).runtimeId, original.runtimeId);
  assert.equal(env.host.metrics.runtimeStarts, 2);
  await assert.rejects(client.unload(a.sessionId), /idle|unattached/i);
  const restored = await client.reconnect(a.sessionId);
  assert.equal(restored.runtimeId, original.runtimeId);
  await client.command({ type: 'abort' });
  await until(async () => !(await client.snapshot()).state.isStreaming);
  await peer.detach(); await client.detach();
  await until(async () => (await client.list()).every((item) => item.runtimeId === null));
  await client.attach(a.sessionId);
  const cold = await client.snapshot();
  assert.notEqual(cold.runtimeId, original.runtimeId);
  assert.equal(cold.messages[0].content, 'background');
  assert.equal(env.host.metrics.runtimeStarts, 3);
});

test('questions survive detach, validate exact offered answers, reject double replies', async (t) => {
  const env = await setup(t);
  const client = await env.client();
  const session = await client.create({ cwd: env.root });
  await client.attach(session.sessionId);
  const before = await client.snapshot();
  await client.command({ type: 'prompt', message: 'question' });
  await client.detach(); await delay(110); await client.attach(session.sessionId);
  const snapshot = await client.snapshot();
  assert.equal(snapshot.runtimeId, before.runtimeId);
  assert.equal(snapshot.pendingUi.length, 1);
  await assert.rejects(client.reply({ id: 'question-1', value: 'invented' }), /offered options/i);
  await client.reply({ id: 'question-1', value: 'yes' });
  await assert.rejects(client.reply({ id: 'question-1', value: 'yes' }), /already answered/i);
  assert.equal((await client.snapshot()).pendingUi.length, 0);
});

test('directory subscriptions receive another client creation without runtime spawn', async (t) => {
  const env = await setup(t);
  const client = await env.client(); const other = await env.client();
  const states = [];
  const unsubscribe = await client.subscribeDirectory((state) => states.push(state));
  const created = await other.create({ cwd: env.root, title: 'External' });
  await until(() => states.some((state) => state.sessions.some((entry) => entry.sessionId === created.sessionId)));
  assert.equal(env.host.metrics.runtimeStarts, 0);
  await unsubscribe();
});

test('real built Rubato candidate starts and resumes through official server', { skip: !process.env.RUBATO_TEST_CANDIDATE }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'rb-profile-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = await setup(t, { workerFactory: (metadata) => new RpcWorker(metadata, {
    cliPath: path.join(process.env.RUBATO_TEST_CANDIDATE, 'rubato-features/rubato-components/candidate-main.mjs'),
    env: { RUBATO_CANDIDATE_AGENT_DIR: profile, HOME: profile } }) });
  const client = await env.client();
  const created = await client.create({ cwd: env.root, title: 'Real Rubato control path' });
  await client.attach(created.sessionId);
  const state = await client.snapshot();
  assert.equal(state.sessionId, created.sessionId);
  assert.equal(state.state.sessionId, created.sessionId);
  assert.ok(Array.isArray(state.messages));
  assert.ok(await client.command({ type: 'get_commands' }));
});
