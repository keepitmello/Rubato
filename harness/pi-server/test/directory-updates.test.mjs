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

test('one event is one published revision: its sequence, its ring slot and the status it causes arrive together; the ring keeps the newest 256', async (t) => {
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
  const metadata = await new SessionFiles(root).create({ cwd: root });
  const host = createSessionHost({ sessionsDir: root, serverId: 'test', pollMs: 0, idleMs: null,
    workerFactory: (value) => (worker = new Worker(value)) });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.start();
  const handle = await host.openSession(await host.resolveSession(metadata.id));
  const seen = [];
  t.after(handle.state.subscribe((value, _context, delivery) => {
    if (delivery.kind === 'update') seen.push({ sequence: value.sequence, last: value.events.at(-1)?.sequence, status: value.status });
  }));
  worker.emit('event', { type: 'agent_start' });
  assert.deepEqual(seen, [{ sequence: 1, last: 1, status: 'running' }]);
  for (let i = 0; i < 300; i++) worker.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
  assert.equal(seen.length, 301);
  assert.ok(seen.every((row) => row.sequence === row.last));
  const { events } = handle.state.value;
  assert.equal(events.length, 256);
  assert.equal(events[0].sequence, 301 - 255);
  assert.equal(events.at(-1).sequence, 301);
});

test('the directory changes by the entries that changed, not by resending every conversation', async () => {
  const { replicatedState } = await import('@earendil-works/chord');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { editSessionList } = await import('../src/host.mjs');
  const item = (id, status = 'stored') => ({ sessionId: `s${id}`, cwd: '/w', status, attachments: 0 });
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let previous = Array.from({ length: 40 }, (_, i) => item(i));
  const state = replicatedState({ sessions: previous });
  let nextId = 40;
  for (let round = 0; round < 300; round++) {
    const next = previous.map((entry) => ({ ...entry }));
    const kind = random(4);
    if (kind === 0) next[random(next.length)].status = 'running';
    else if (kind === 1) next.unshift(...next.splice(random(next.length), 1));
    else if (kind === 2 && next.length > 1) next.splice(random(next.length), 1 + random(3));
    else next.splice(random(next.length + 1), 0, item(nextId++));
    state.change(BACKGROUND_CONTEXT, (draft) => { editSessionList(draft.sessions, previous, next); });
    assert.deepEqual(state.value.sessions, next, `round ${round}`);
    previous = next;
  }
  // One conversation's status: one entry written. One moved to the top: one entry inserted.
  const written = [];
  const recording = (list) => new Proxy(list, {
    set(target, key, value) { if (key !== 'length') written.push(value); return Reflect.set(target, key, value); },
    get(target, key) {
      if (key !== 'splice') return Reflect.get(target, key);
      return (...args) => { written.push(...args.slice(2)); return target.splice(...args); };
    },
  });
  const many = Array.from({ length: 2000 }, (_, i) => item(i));
  const status = many.map((entry, i) => (i === 1500 ? { ...entry, status: 'running' } : entry));
  assert.equal(editSessionList(recording(many.slice()), many, status), true);
  assert.deepEqual(written, [status[1500]]);
  written.length = 0;
  const moved = [many[900], ...many.slice(0, 900), ...many.slice(901)];
  editSessionList(recording(many.slice()), many, moved);
  assert.deepEqual(written, [many[900]]);
  assert.equal(editSessionList(recording(many.slice()), many, many.map((entry) => ({ ...entry }))), false);
});
