import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SessionFiles } from '../src/session-files.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { startSessionServer } from '../src/host.mjs';
import { SessionClient } from '../src/client.mjs';
import { wire, measure, FRAME_BUDGET, EVENTS_BUDGET } from '../src/wire.mjs';

const fixture = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
const until = async (predicate) => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await delay(10); } throw new Error('Condition did not settle'); };

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-wire-'));
  const sessionsDir = path.join(root, 'sessions');
  const socketPath = path.join(root, 'pi.sock');
  const errors = [];
  const service = await startSessionServer({ socketPath, sessionsDir, idleMs: null, pollMs: 50,
    workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: fixture }), onError: (error) => errors.push(error), ...options });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((client) => client.close())); await service.close(); await rm(root, { force: true, recursive: true }); });
  const client = async () => { const instance = await new SessionClient({ socketPath, serverId: service.serverId, timeoutMs: 60000, onError: (error) => errors.push(error) }).connect(); clients.push(instance); return instance; };
  return { ...service, root, sessionsDir, socketPath, client, errors };
}

test('text the protocol cannot encode is repaired, not dropped on the floor', () => {
  const framed = wire({ note: 'a pair 😀 survives, half of one \uD83D does not' });
  assert.equal(framed.note, 'a pair 😀 survives, half of one \uFFFD does not');
});

test('a payload inside the budget crosses unchanged', () => {
  const payload = { title: '세션', entries: [1, 2, { text: 'unchanged' }], empty: null };
  assert.deepEqual(wire(payload), payload);
});

test('an oversized payload loses its largest strings, never its small ones', () => {
  const framed = measure({ keep: 'a sentence', blob: 'A'.repeat(40 * 1024 * 1024), tail: 'also kept' });
  assert.ok(framed.bytes <= FRAME_BUDGET, `${framed.bytes} bytes still exceeds the budget`);
  assert.equal(framed.value.keep, 'a sentence');
  assert.equal(framed.value.tail, 'also kept');
  assert.match(framed.value.blob, /rubato: elided \d+ bytes/);
});

test('a transcript larger than one frame opens, and the connection survives it', async (t) => {
  const env = await setup(t);
  const files = new SessionFiles(env.sessionsDir);
  const created = await files.create({ cwd: env.root, title: 'Screenshots' });
  const manager = SessionManager.open(created.file, env.sessionsDir);
  manager.appendMessage({ role: 'assistant', timestamp: Date.now(), content: [
    { type: 'text', text: 'the sentence a person wants to read again' },
    { type: 'image', mimeType: 'image/png', data: 'A'.repeat(40 * 1024 * 1024) },
  ] });
  const client = await env.client();
  const transcript = await client.transcript(created.id);
  const content = transcript.messages.at(-1).content;
  assert.equal(content[0].text, 'the sentence a person wants to read again');
  assert.match(content[1].data, /rubato: elided \d+ bytes/);
  // The same connection still answers: nothing was torn down to deliver this.
  assert.ok((await client.list()).some((session) => session.sessionId === created.id));
  assert.deepEqual(env.errors.map((error) => error.message), []);
});

test('a live turn with unencodable text and screenshot-sized events keeps its subscription', async (t) => {
  const env = await setup(t);
  const client = await env.client();
  const session = await client.create({ cwd: env.root, title: 'Live' });
  await client.attach(session.sessionId);
  const states = [];
  const unsubscribe = await client.subscribeSession((state) => states.push(state));
  await client.command({ type: 'prompt', message: 'lone' });
  await until(() => states.some((state) => JSON.stringify(state.events).includes('\uFFFD')));
  await client.command({ type: 'prompt', message: 'screenshots' });
  await until(() => states.some((state) => JSON.stringify(state.events).includes('rubato: elided')));
  const latest = states.at(-1);
  assert.ok(Buffer.byteLength(JSON.stringify(latest.events)) <= EVENTS_BUDGET + 1024 * 1024,
    'the published event window outgrew its budget');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(JSON.stringify(latest.events)));
  // Still the same attachment, still answering.
  assert.equal((await client.snapshot()).sessionId, session.sessionId);
  await unsubscribe();
  assert.deepEqual(env.errors.map((error) => error.message), []);
});

test('session control RPCs do not inherit the directory AbortSignal timeout', async () => {
  const signals = [];
  const serverId = '00000000-0000-4000-8000-000000000001';
  const client = new SessionClient({ socketPath: '/tmp/rb-unused.sock', serverId, timeoutMs: 40 });
  client.client = {
    attachment: { serverId, sessionId: 's', attachmentId: 'a' },
    serverId,
    request(_target, _call, signal) { signals.push(signal); return Promise.resolve(null); },
  };
  await client.command({ type: 'get_state' });
  await client.list();
  assert.equal(signals[0], undefined);
  assert.ok(signals[1] instanceof AbortSignal);
});
