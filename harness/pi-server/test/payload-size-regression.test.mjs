// One failure class, four paths: a payload too large for the wire stopped a whole session.
// Each case below replays one incident through the real code that now guards it.
//
//   1. request   — history images over Anthropic's 32MB request cap (413), every turn refused
//                  (PR #20, 4ab50e30a; request side redesigned in 98dee649e)
//   2. get_messages — 41 screenshots made a 36MB history answer, over the 32MiB frame (4d2908e9b)
//   3. text-heavy — 19MB text + 11MB images: the image-only budget dropped nothing, both the
//                  request and the history answer crossed 32MB (97c80050f)
//   4. get_entries — a 222MB session listed every entry and crossed the frame; any other
//                  answer that cannot cross now fails only its own request (b9d9a2a11)
//
// The worker and the context controller are the real ones. Only Pi's answers and the session
// store are fixtures, the same ones session-worker.test.mjs and the context-notes unit tests use.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionWorker } from '../src/session-worker.mjs';
import { ContextNotesController } from '../../rubato-pi/src/context-notes/controller.mjs';
import { contextNotesConfig } from '../../rubato-pi/src/context-notes/config.mjs';
import { ANTHROPIC_SERVER_COMPACTION_MODEL_IDS } from '../../rubato-pi/src/context-budget.mjs';
import { fakeSession } from '../../rubato-pi/test/helpers/context-notes-fake.mjs';

const MiB = 1024 * 1024;
/** Anthropic refuses a larger request body with 413 request_too_large. */
const PROVIDER_REQUEST_CAP = 32 * MiB;
/** One frame across the worker boundary and the presentation transport. */
const FRAME_LIMIT = 32 * MiB;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

// --- request path: the real ContextNotesController over the context-notes session fake ----------

const png = (decoded) => ({ type: 'image', mimeType: 'image/png', data: Buffer.alloc(decoded, 7).toString('base64') });

function controllerSession(t) {
  const f = fakeSession(t);
  // Claude: the incidents were Anthropic 413s, and its token usage stays low while bytes grow.
  f.ctx.model = { provider: 'anthropic', api: 'anthropic-messages', id: ANTHROPIC_SERVER_COMPACTION_MODEL_IDS[0], contextWindow: 1000000 };
  f.ctx.getContextUsage = () => ({ tokens: 100 });
  f.addMessage('user', 'Inspect the screenshots, then continue.');
  f.c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false, config: contextNotesConfig({}) });
  t.after(() => f.c.close());
  f.c.writeNote({ path: 'now.md', text: 'Inspect screenshots; continue after reading the result.' }, f.ctx);
  return f;
}

/**
 * What the model would receive for the next turn. A request may be fitted under the cap, or
 * refused before the model is called and continued from a new window. Either way the session
 * goes on, the record keeps every byte, and nothing over the cap is sent.
 */
async function nextRequest(f) {
  const prepare = () => f.c.prepareContext({ messages: f.build().messages }, f.ctx).messages;
  // Every message entry the session file holds, in order: what the record keeps.
  const record = () => f.entries.filter((entry) => entry.type === 'message').map((entry) => entry.message);
  const before = record();
  const kept = () => JSON.stringify(record().slice(0, before.length)) === JSON.stringify(before);
  let prepared;
  try {
    prepared = prepare();
  } catch (refusal) {
    assert.ok(kept(), `refused without editing the record: ${refusal.message}`);
    const window = f.c.window.number;
    await f.c.turnEnd({ message: { stopReason: 'error', errorMessage: refusal.message } }, f.ctx);
    assert.equal(f.c.window.number, window + 1, `a refused request continues in a new window: ${refusal.message}`);
    assert.ok(!f.c.paused, `the session is not paused: ${f.c.paused}`);
    prepared = prepare();
  }
  assert.ok(kept(), 'the session record keeps every original image and message');
  assert.equal(f.abort.signal.aborted, false, 'the session was not aborted');
  const size = bytes({ messages: prepared, systemPrompt: f.ctx.getSystemPrompt() });
  assert.ok(size < PROVIDER_REQUEST_CAP, `a ${size}-byte request would be refused with 413 request_too_large`);
  return prepared;
}

function screenshotRound(f, images) {
  f.addMessage('assistant', [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'screen.png' } }],
    { stopReason: 'toolUse' });
  f.addMessage('toolResult', images, { toolName: 'read', toolCallId: 'read-1' });
}

test('path 1 · a history of screenshots over the provider request cap is never sent at that size, and the session goes on', async (t) => {
  const f = controllerSession(t);
  // The incident: toolResult screenshots re-sent every turn, 34-36MB, every turn a 413.
  screenshotRound(f, Array.from({ length: 9 }, () => png(3 * MiB)));
  assert.ok(bytes(f.build().messages) > 36 * MiB);
  await nextRequest(f);
});

test('path 3 · request · text that leaves too little room for its images still never crosses the cap', async (t) => {
  const f = controllerSession(t);
  // The incident: 19MB of text and 11MB of images. The images fit their own 16MB budget.
  f.addMessage('user', 'x'.repeat(19 * MiB));
  screenshotRound(f, Array.from({ length: 4 }, () => png(Math.floor(11 * MiB / 4))));
  assert.ok(bytes(f.build().messages) > PROVIDER_REQUEST_CAP);
  await nextRequest(f);
});

// --- answer path: the real SessionWorker, with Pi answering each command from a table ----------

/** The in-process worker fixture of session-worker.test.mjs: Pi answers each command type from `answers`. */
function answering(t, id, answers) {
  const worker = new SessionWorker({ id, file: `/fixture/${id}.jsonl`, cwd: `/fixture/${id}` }, {
    createRuntime: async () => ({ session: { abort: async () => {} }, dispose: async () => {} }),
    runRpcMode: async (_runtime, transport) => ({
      dispatch: async (command) => transport.output({ type: 'response', id: command.id, success: true,
        data: command.type === 'get_state' ? { sessionId: id } : answers[command.type] }),
      close: async () => transport.onClose(),
    }),
  });
  t.after(() => worker.stop());
  return worker;
}

/** The session that sent an oversized answer still serves its next request. */
async function assertAlive(worker, id) {
  assert.equal(worker.closed, false, 'the session was not stopped');
  assert.equal((await worker.request({ type: 'get_state' })).sessionId, id);
}

test('path 2 · a history answer with more screenshots than one frame holds arrives, newest image intact', async (t) => {
  // The incident: 41 screenshots, a 36MB get_messages answer, the thread could not be opened.
  const shot = (tag) => ({ role: 'toolResult', content: [{ type: 'text', text: tag },
    { type: 'image', mimeType: 'image/png', data: tag.repeat(16 * MiB) }] });
  const messages = ['A', 'B', 'C'].map(shot);
  assert.ok(bytes(messages) > FRAME_LIMIT);
  const worker = answering(t, 'images', { get_messages: { messages } });
  await worker.start();
  const { data } = await worker.request({ type: 'get_messages' }, { withBoundary: true });
  assert.ok(bytes(data) <= FRAME_LIMIT);
  assert.deepEqual(data.messages.map((message) => message.content[1].type), ['text', 'text', 'image']);
  assert.equal(data.messages[2].content[1].data, messages[2].content[1].data);
  assert.equal(messages[0].content[1].type, 'image', 'the live session history is not mutated');
  await assertAlive(worker, 'images');
});

test('path 3 · answer · a text-heavy history whose images fit their own budget still fits one frame', async (t) => {
  // The incident: 19MB text + 11MB images answered 39KB over the frame, every attach died.
  const text = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(22 * MiB) }] };
  const shot = (tag) => ({ role: 'toolResult', content: [{ type: 'text', text: tag },
    { type: 'image', mimeType: 'image/png', data: tag.repeat(4 * MiB) }] });
  const messages = [text, shot('A'), shot('B'), shot('C')];
  assert.ok(bytes(messages) > FRAME_LIMIT);
  const worker = answering(t, 'text-heavy', { get_messages: { messages } });
  await worker.start();
  const { data } = await worker.request({ type: 'get_messages' }, { withBoundary: true });
  assert.ok(bytes(data) <= FRAME_LIMIT);
  assert.equal(data.messages[0].content[0].text, text.content[0].text, 'text is never dropped');
  assert.equal(data.messages.at(-1).content[1].type, 'image', 'the newest image stays');
  assert.equal(data.messages[1].content[1].type, 'text', 'the oldest image gives way');
  await assertAlive(worker, 'text-heavy');
});

test('path 4 · a session listing larger than one frame arrives as a tree its readers can still walk', async (t) => {
  // The incident: a 222MB session answered get_entries with 222MB; T3 asks for it on every attach.
  const at = '2026-10-17T00:00:00.000Z';
  const entries = [
    { id: 'u1', parentId: null, type: 'message', timestamp: at, message: { role: 'user', content: 'hi', timestamp: 1 } },
    { id: 'a1', parentId: 'u1', type: 'message', timestamp: at, message: { role: 'assistant', timestamp: 2, model: 'm',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'x'.repeat(1000) } }] } },
    { id: 'r1', parentId: 'a1', type: 'message', timestamp: at, message: { role: 'toolResult', toolCallId: 'call-1',
      toolName: 'read', timestamp: 3, content: [{ type: 'text', text: 'y'.repeat(40 * MiB) }] } },
    { id: 'u2', parentId: 'r1', type: 'message', timestamp: at, message: { role: 'user', content: 'next', timestamp: 4 } },
  ];
  assert.ok(bytes(entries) > FRAME_LIMIT);
  const worker = answering(t, 'long', { get_entries: { entries, leafId: 'u2' } });
  await worker.start();
  const data = await worker.request({ type: 'get_entries' });
  assert.ok(bytes(data) <= FRAME_LIMIT);
  assert.equal(data.leafId, 'u2');
  assert.deepEqual(data.entries.map(({ id, parentId, type }) => [id, parentId, type]),
    entries.map(({ id, parentId, type }) => [id, parentId, type]), 'every entry keeps its place in the tree');
  const reply = data.entries[1].message;
  assert.deepEqual([reply.role, reply.timestamp, reply.model], ['assistant', 2, 'm'], 'a reply keeps what its rewind fingerprint hashes');
  assert.deepEqual(reply.content.map(({ id }) => id), ['call-1'], 'a step keeps its tool call id');
  assert.equal(entries[2].message.content[0].text.length, 40 * MiB, 'the live session entries are not mutated');
  await assertAlive(worker, 'long');
});

test('path 4 · any other answer too large for a frame fails only its own request; an event that large still stops the session', async (t) => {
  const worker = answering(t, 'overflow', { get_tree: { text: 'x'.repeat(33 * MiB) } });
  await worker.start();
  await assert.rejects(worker.request({ type: 'get_tree' }), /frame exceeds limit/);
  assert.equal(worker.pending.size, 0, 'the failed request leaves nothing pending');
  await assertAlive(worker, 'overflow');
  // An event cannot be dropped without breaking the stream every presentation replays.
  worker.output({ type: 'fixture_event', text: 'x'.repeat(33 * MiB) });
  assert.match((await worker.terminated).message, /frame exceeds limit/);
});
