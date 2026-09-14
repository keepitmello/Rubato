import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionWorker } from '../src/session-worker.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(id, extra = {}) {
  let aborts = 0, disposals = 0;
  const runtime = { session: { abort: async () => { aborts++; } }, dispose: async () => { disposals++; } };
  const worker = new SessionWorker({ id, file: `/fixture/${id}.jsonl`, cwd: `/fixture/${id}` }, {
    createRuntime: async () => runtime,
    runRpcMode: async (_runtime, transport) => ({
      dispatch: async command => {
        if (command.type === 'blocked') return;
        transport.output({ type: 'fixture_event', id });
        transport.output({ type: 'response', id: command.id, success: true,
          data: command.type === 'get_state' ? { sessionId: id } : { id, command: command.type } });
      },
      close: async () => { await runtime.session.abort(); await runtime.dispose(); transport.onClose(); },
    }), ...extra,
  });
  return { worker, runtime, aborts: () => aborts, disposals: () => disposals };
}

test('in-process worker preserves the host request/event boundary and isolates peers', async () => {
  const a = fixture('a'), b = fixture('b');
  await Promise.all([a.worker.start(), b.worker.start()]);
  const result = await a.worker.request({ type: 'get_messages' }, { withBoundary: true });
  assert.deepEqual(result.data, { id: 'a', command: 'get_messages' });
  assert.equal(result.eventSequence, 2);
  const pending = a.worker.request({ type: 'blocked' });
  const rejected = assert.rejects(pending, /stopped/);
  await Promise.all([a.worker.stop(), a.worker.stop(), rejected]);
  assert.equal(a.disposals(), 1); assert.equal(a.aborts(), 1);
  assert.equal((await b.worker.request({ type: 'get_state' })).sessionId, 'b');
  await b.worker.stop();
});

test('stop during startup waits for and disposes the newly created runtime before termination', async () => {
  const gate = deferred();
  const f = fixture('slow', { createRuntime: async () => { await gate.promise; return f.runtime; } });
  const start = assert.rejects(f.worker.start(), /stopped during startup/);
  const stop = f.worker.stop();
  let terminated = false;
  void f.worker.terminated.then(() => { terminated = true; });
  await Promise.resolve(); assert.equal(terminated, false);
  gate.resolve();
  await Promise.all([start, stop]);
  assert.equal(terminated, true); assert.equal(f.disposals(), 1);
});

test('failed binding is cleaned up and timeout does not report successful execution', async () => {
  const f = fixture('failure', { runRpcMode: async () => { throw new Error('bind failure'); } });
  await assert.rejects(f.worker.start(), /bind failure/);
  assert.equal(f.disposals(), 1);
  assert.match((await f.worker.terminated).message, /bind failure/);
  const slow = fixture('timeout', { timeoutMs: 10 });
  await slow.worker.start();
  await assert.rejects(slow.worker.request({ type: 'blocked' }), /outcome may be unknown/);
  assert.equal(slow.worker.pending.size, 0);
  await slow.worker.stop();
});

test('a normal transport close callback does not erase the owning failure', async () => {
  const f = fixture('broken');
  await f.worker.start();
  await f.worker.stop(new Error('owning failure'));
  assert.match((await f.worker.terminated).message, /owning failure/);
  assert.equal(f.disposals(), 1);
});

test('extension-initiated close waits for context disposal exactly once', async () => {
  const gate = deferred(); let disposeCount = 0, close;
  const f = fixture('self-close', {
    disposeContext: async () => { disposeCount++; await gate.promise; },
    runRpcMode: async (_runtime, transport) => {
      close = () => transport.onClose();
      return { dispatch: async command => transport.output({ type: 'response', id: command.id,
        success: true, data: { sessionId: 'self-close' } }), close: async () => close() };
    },
  });
  await f.worker.start(); close();
  let terminated = false; void f.worker.terminated.then(() => { terminated = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposeCount, 1); assert.equal(terminated, false);
  gate.resolve(); await f.worker.terminated; await f.worker.stop();
  assert.equal(disposeCount, 1);
});

test('malformed output closes only its own worker and preserves the failure', async () => {
  for (const invalid of [null, [], 'text', {}]) {
    const a = fixture('invalid'), b = fixture('peer');
    await Promise.all([a.worker.start(), b.worker.start()]);
    a.worker.output(invalid);
    assert.match((await a.worker.terminated).message, /Invalid Pi RPC frame/);
    assert.equal(a.disposals(), 1);
    assert.equal((await b.worker.request({ type: 'get_state' })).sessionId, 'peer');
    await b.worker.stop();
  }
});
