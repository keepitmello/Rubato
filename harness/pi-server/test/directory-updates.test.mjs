import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionHost, startSessionServer } from '../src/host.mjs';
import { SessionFiles } from '../src/session-files.mjs';
import { SessionClient } from '../src/client.mjs';

test('text events keep their session sequence but do not rebuild the directory; lifecycle changes still publish', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-directory-'));
  let worker;
  class Worker extends EventEmitter {
    constructor(metadata) {
      super(); this.id = 'fixture-runtime'; this.metadata = metadata;
      this.terminated = new Promise((resolve) => { this.finish = resolve; });
    }
    start() { return Promise.resolve({ sessionId: this.metadata.id, isStreaming: false }); }
    stop() { this.finish(); return this.terminated; }
    request() { return this.start(); }
    reply() {}
  }
  const files = new SessionFiles(root);
  const metadata = await files.create({ cwd: root });
  const host = createSessionHost({ sessionsDir: root, serverId: 'test', pollMs: 0, idleMs: null,
    workerFactory: (value) => (worker = new Worker(value)) });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.start();
  const handle = await host.openSession(await host.resolveSession(metadata.id));
  let updates = 0;
  const unsubscribe = handle.state.subscribe((_value, _context, delivery) => { if (delivery.kind === 'update') updates++; });
  t.after(unsubscribe);
  const before = host.directory.value.revision;
  for (let i = 0; i < 250; i++) worker.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
  assert.equal(updates, 250);
  assert.equal(handle.state.value.sequence, 250);
  assert.equal(host.directory.value.revision, before);
  worker.emit('event', { type: 'agent_start' });
  assert.equal(host.directory.value.sessions[0].status, 'running');
  assert.equal(host.directory.value.revision, before + 1);
  worker.emit('event', { type: 'extension_ui_request', method: 'confirm', id: 'q', title: 'Continue?' });
  handle.acceptState({ sessionId: metadata.id, isStreaming: false });
  assert.equal(host.directory.value.sessions[0].status, 'waiting');
  assert.equal(host.directory.value.revision, before + 2);
  await handle.reply({ id: 'q', confirmed: true });
  assert.equal(host.directory.value.sessions[0].status, 'idle');
  const attached = handle.attachClient();
  assert.equal(host.directory.value.sessions[0].attachments, 1);
  attached.release();
  assert.equal(host.directory.value.sessions[0].attachments, 0);
  assert.equal(host.directory.value.revision, before + 5);
});

test('real directory transport: unchanged lists stay quiet while external creation/deletion still update', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-dir-wire-'));
  const sessionsDir = path.join(root, 'sessions');
  const server = await startSessionServer({ sessionsDir, socketPath: path.join(root, 'pi.sock'), pollMs: 0 });
  const client = await new SessionClient({ socketPath: path.join(root, 'pi.sock'), serverId: server.serverId }).connect();
  const states = [];
  const unsubscribe = await client.subscribeDirectory((state) => states.push(state));
  t.after(async () => { await unsubscribe(); await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const revision = server.host.directory.value.revision;
  await Promise.all(Array.from({ length: 10 }, () => client.list()));
  assert.equal(server.host.directory.value.revision, revision);
  const external = await new SessionFiles(sessionsDir).create({ cwd: root, title: 'External' });
  assert.equal((await client.list())[0].title, 'External');
  assert.equal(server.host.directory.value.revision, revision + 1);
  assert.ok(states.some((value) => value.sessions.some((item) => item.sessionId === external.id)));
  for (let i = 0; i < 3; i++) await client.list();
  assert.equal(server.host.directory.value.revision, revision + 1);
  await rm(external.file);
  assert.deepEqual(await client.list(), []);
  assert.equal(server.host.directory.value.revision, revision + 2);
  assert.equal(server.host.metrics.runtimeStarts, 0);
});
