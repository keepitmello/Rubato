import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionWorker } from '../src/session-worker.mjs';
import { messageFingerprint } from '../../pi-runtime/features/conversation-rewind/rewind.mjs';

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

/** A worker whose Pi answers each command type from `answers`; get_state names the session. */
const answering = (id, answers) => fixture(id, { runRpcMode: async (_runtime, transport) => ({
  dispatch: async (command) => transport.output({ type: 'response', id: command.id, success: true,
    data: command.type === 'get_state' ? { sessionId: id } : answers[command.type] }),
  close: async () => transport.onClose(),
}) });

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

test('history with more inline images than one frame holds keeps the newest and the session alive', async () => {
  // 3 x 16MB of base64 (12MB decoded each): 48MB encoded, over the 32MB frame limit.
  const image = (tag) => ({ type: 'image', mimeType: 'image/png', data: tag.repeat(16 * 1024 * 1024) });
  const messages = ['A', 'B', 'C'].map((tag) => ({ role: 'toolResult', content: [{ type: 'text', text: tag }, image(tag)] }));
  const f = fixture('images', {
    runRpcMode: async (_runtime, transport) => ({
      dispatch: async (command) => transport.output({ type: 'response', id: command.id, success: true,
        data: command.type === 'get_state' ? { sessionId: 'images' } : { messages } }),
      close: async () => transport.onClose(),
    }),
  });
  await f.worker.start();
  const { data } = await f.worker.request({ type: 'get_messages' }, { withBoundary: true });
  const kinds = data.messages.map((message) => message.content[1].type);
  assert.deepEqual(kinds, ['text', 'text', 'image']);
  assert.equal(data.messages[2].content[1].data, messages[2].content[1].data);
  assert.equal(messages[0].content[1].type, 'image', 'the live session history is not mutated');
  assert.equal(f.worker.closed, false);
  await f.worker.stop();
});

test('history whose text leaves too little room for its images still fits one frame', async () => {
  // 22MB of text plus 3 x 4MB base64 images: the images fit their own budget, the frame does not.
  const text = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(22 * 1024 * 1024) }] };
  const shot = (tag) => ({ role: 'toolResult', content: [{ type: 'text', text: tag }, { type: 'image', mimeType: 'image/png', data: tag.repeat(4 * 1024 * 1024) }] });
  const messages = [text, shot('A'), shot('B'), shot('C')];
  const f = fixture('text-heavy', {
    runRpcMode: async (_runtime, transport) => ({
      dispatch: async (command) => transport.output({ type: 'response', id: command.id, success: true,
        data: command.type === 'get_state' ? { sessionId: 'text-heavy' } : { messages } }),
      close: async () => transport.onClose(),
    }),
  });
  await f.worker.start();
  const { data } = await f.worker.request({ type: 'get_messages' }, { withBoundary: true });
  assert.equal(data.messages.at(-1).content[1].type, 'image', 'the newest image stays');
  assert.equal(data.messages[1].content[1].type, 'text', 'the oldest image gives way');
  assert.equal(f.worker.closed, false);
  await f.worker.stop();
});

test('a session listing larger than one frame comes back as its outline and the session stays alive', async () => {
  const at = '2026-10-17T00:00:00.000Z';
  const entries = [
    { id: 'u1', parentId: null, type: 'message', timestamp: at, message: { role: 'user', content: 'hi', timestamp: 1 } },
    { id: 'a1', parentId: 'u1', type: 'message', timestamp: at, message: { role: 'assistant', timestamp: 2, model: 'm', provider: 'p',
      usage: { input: 1 }, content: [{ type: 'thinking', thinking: 't'.repeat(1000) },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'x'.repeat(1000) } }] } },
    { id: 'r1', parentId: 'a1', type: 'message', timestamp: at, message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read',
      timestamp: 3, content: [{ type: 'text', text: 'y'.repeat(40 * 1024 * 1024) }] } },
    { id: 'c1', parentId: 'r1', type: 'compaction', timestamp: at, summary: 's'.repeat(2000), firstKeptEntryId: 'u1', tokensBefore: 10 },
    { id: 'k1', parentId: 'c1', type: 'custom', timestamp: at, customType: 'rubato.context-note.v1', data: { text: 'z'.repeat(1000) } },
  ];
  const f = answering('long', { get_entries: { entries, leafId: 'k1' } });
  await f.worker.start();
  const data = await f.worker.request({ type: 'get_entries' });
  assert.equal(data.rubatoOutlined, true);
  assert.equal(data.leafId, 'k1');
  assert.deepEqual(data.entries.map(({ id, parentId, type }) => [id, parentId, type]),
    entries.map(({ id, parentId, type }) => [id, parentId, type]));
  assert.deepEqual(data.entries[1].message, { role: 'assistant', timestamp: 2, model: 'm', provider: 'p',
    content: [{ type: 'toolCall', id: 'call-1', name: 'read' }] });
  assert.deepEqual(data.entries[2].message, { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', timestamp: 3, content: [] });
  assert.equal(data.entries[3].summary, undefined);
  assert.equal(data.entries[3].firstKeptEntryId, 'u1');
  assert.equal(data.entries[4].customType, 'rubato.context-note.v1');
  assert.equal(data.entries[4].data, undefined);
  assert.equal(messageFingerprint(data.entries[1].message), messageFingerprint(entries[1].message));
  assert.equal(entries[2].message.content[0].text.length, 40 * 1024 * 1024, 'the live session entries are not mutated');
  assert.equal(f.worker.closed, false);
  assert.equal((await f.worker.request({ type: 'get_state' })).sessionId, 'long');
  await f.worker.stop();
});

test('a listing that fits one frame comes back whole', async () => {
  const at = '2026-10-17T00:00:00.000Z';
  const entries = [
    { id: 'u1', parentId: null, type: 'message', timestamp: at, message: { role: 'user', content: 'hi', timestamp: 1 } },
    { id: 'a1', parentId: 'u1', type: 'message', timestamp: at, message: { role: 'assistant', timestamp: 2, model: 'm',
      content: [{ type: 'text', text: 'ok' }] } },
    { id: 'u2', parentId: 'a1', type: 'message', timestamp: at, message: { role: 'user', content: 'again', timestamp: 3 } },
  ];
  const f = answering('short', { get_entries: { entries, leafId: 'u2' } });
  await f.worker.start();
  const data = await f.worker.request({ type: 'get_entries' });
  assert.deepEqual(data, { entries, leafId: 'u2' });
  await f.worker.stop();
});

test('an answer too large for a frame fails only its request, an event that large still stops the session', async () => {
  const f = answering('overflow', { get_tree: { text: 'x'.repeat(33 * 1024 * 1024) } });
  await f.worker.start();
  await assert.rejects(f.worker.request({ type: 'get_tree' }), /Pi RPC frame exceeds limit: get_tree/);
  assert.equal(f.worker.closed, false);
  assert.equal(f.worker.pending.size, 0);
  assert.equal((await f.worker.request({ type: 'get_state' })).sessionId, 'overflow');
  f.worker.output({ type: 'fixture_event', text: 'x'.repeat(33 * 1024 * 1024) });
  assert.match((await f.worker.terminated).message, /Pi RPC frame exceeds limit/);
});
