import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionHost, startSessionServer } from '../src/host.mjs';
import { SessionFiles } from '../src/session-files.mjs';
import { SessionClient } from '../src/client.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { SessionWorker } from '../src/session-worker.mjs';
import { createSessionCursor } from '../src/session-cursor.mjs';

test('prepared/import identities cannot redirect a stored conversation or write a duplicate', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-present-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new SessionFiles(path.join(root, 'sessions'));
  const metadata = await files.create({ cwd: root, title: 'original' });
  const before = await readFile(metadata.file);
  const host = createSessionHost({ sessionsDir: files.root, serverId: 'ownership-test', pollMs: 0 });
  const duplicate = path.join(root, 'external.jsonl'); await copyFile(metadata.file, duplicate);
  await assert.rejects(host.prepareSession({ ...metadata, file: duplicate }, {}), /different persisted file/);
  await assert.rejects(host.resolveImport(duplicate), /duplicate an existing conversation ID/);
  assert.equal(await host.resolveImport(metadata.file), metadata.file);
  assert.deepEqual(await readFile(metadata.file), before);
  const release = await host.prepareSession(metadata, {});
  assert.equal((await host.resolveSession(metadata.id)).file, metadata.file);
  await assert.rejects(host.prepareSession(metadata, {}), /already in progress/);
  release();
  assert.equal((await host.resolveSession(metadata.id)).file, metadata.file);
  assert.equal(host.metrics.runtimeStarts, 0);
  await host.close();
});

test('one CLI controller, GUI observers, and other conversations keep independent authority', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-present-'));
  const server = await startSessionServer({ sessionsDir: path.join(root, 'sessions'), socketPath: path.join(root, 'pi.sock'),
    idleMs: null, pollMs: 0, workerFactory: metadata => new RpcWorker(metadata, { cliPath: path.join(import.meta.dirname, 'fixtures/rpc.mjs') }) });
  const a = await new SessionClient({ socketPath: path.join(root, 'pi.sock'), serverId: server.serverId }).connect();
  const b = await new SessionClient({ socketPath: path.join(root, 'pi.sock'), serverId: server.serverId }).connect();
  t.after(async () => { await a.close(); await b.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const first = await a.create({ cwd: root }), second = await b.create({ cwd: root });
  await a.attach(first.sessionId); await b.attach(second.sessionId);
  const release = server.host.claimPresentation(first.sessionId, 'terminal-a');
  assert.throws(() => server.host.claimPresentation(first.sessionId, 'terminal-b'), /another CLI/);
  assert.equal((await a.snapshot()).state.sessionId, first.sessionId);
  await assert.rejects(a.command({ type: 'abort' }), /controlled by a CLI/);
  await b.command({ type: 'abort' });
  release(); await a.command({ type: 'abort' });
  const unsubscribe = await a.subscribeSession(() => {});
  // The client must wait for an in-flight unsubscribe before closing its RPC
  // transport, including when a presentation does not await its own cleanup.
  await Promise.all([unsubscribe(), a.close()]);
});

test('cursor dismissal releases a tool waiting for UI before awaiting idle', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-present-close-'));
  const events = [];
  let answer;
  const question = new Promise(resolve => { answer = resolve; });
  const runtime = { session: { abort: async () => { events.push('abort'); await question; events.push('idle'); } }, services: {} };
  const server = await startSessionServer({ sessionsDir: path.join(root, 'sessions'), socketPath: path.join(root, 'pi.sock'),
    idleMs: null, pollMs: 0, workerFactory: (metadata, creation) => new SessionWorker(metadata, {
      createRuntime: creation.createRuntime,
      runRpcMode: async (_runtime, transport) => ({
        dispatch: async command => transport.output({ type: 'response', id: command.id, success: true, data: { sessionId: metadata.id } }),
        activatePresentation: async () => { events.push('rpc'); },
        close: async () => transport.onClose(),
      }),
    }) });
  let cursor, closing;
  t.after(async () => { answer(); await closing; await cursor?.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const files = new SessionFiles(path.join(root, 'sessions'));
  const metadata = await files.create({ cwd: root });
  const initial = { sessionManager: { getSessionId: () => metadata.id, getSessionFile: () => metadata.file,
    getCwd: () => root, getHeader: () => ({ id: metadata.id }), getEntries: () => [] } };
  class PresentationRuntime {
    constructor(_session, _services, _acquire, _diagnostics, _fallback, lifecycle) { this.lifecycle = lifecycle; }
    dispose(invalidate) { return this.lifecycle.dispose(invalidate); }
  }
  cursor = await createSessionCursor({ host: server.host,
    descriptor: { socketPath: path.join(root, 'pi.sock'), serverId: server.serverId }, initial,
    scope: { env: {}, assertOpen() {}, run: fn => fn() }, createRuntime: () => runtime,
    api: { outsideUi: fn => fn(), createAgentSessionRuntime: async () => runtime, AgentSessionRuntime: PresentationRuntime } });
  closing = cursor.dispose(() => {
    // Dismissal does not prematurely release this conversation's control lease.
    assert.throws(() => server.host.claimPresentation(metadata.id, 'other-cli'), /another CLI/);
    events.push('dismiss'); answer();
  });
  let timer;
  try { await Promise.race([closing, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Question dismissal deadlocked')), 1000); })]); }
  finally { clearTimeout(timer); }
  assert.deepEqual(events, ['abort', 'dismiss', 'idle', 'rpc']);
  assert.equal(server.host.getSessionWorker(metadata.id).closed, false, 'detaching UI does not destroy the SDK actor');
  server.host.claimPresentation(metadata.id, 'next-cli')();
});
