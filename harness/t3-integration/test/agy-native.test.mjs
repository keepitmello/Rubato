import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  agyLogDirectory, batchEnd, clearCut, createAgyNative, keptThrough, languageServerPort, readCut, toolBatches,
  writeBatches, writeCut,
} from '../agy-native.mjs';

// agy's own step shapes (GetCascadeTrajectorySteps, agy 1.5.16), trimmed to what is read.
const at = (second) => `2026-11-24T11:00:${String(second).padStart(2, '0')}.000000Z`;
const user = (second) => ({ type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: { createdAt: at(second) } });
const planner = (second, ...calls) => ({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: at(second) },
  plannerResponse: { toolCalls: calls.map((id) => ({ id })) } });
const tool = (second, id) => ({ type: 'CORTEX_STEP_TYPE_VIEW_FILE', metadata: { createdAt: at(second), toolCall: { id } } });

// Turn one: a question, a reply. Turn two: a response calling a and b together, their results,
// then c alone, then the reply.
const steps = [
  user(1), planner(2),
  user(10), planner(11, 'a', 'b'), tool(12, 'a'), tool(13, 'b'), planner(14, 'c'), tool(15, 'c'), planner(16),
];

test('calls one model response made answer together; a lone call is its own batch', () => {
  assert.deepEqual(toolBatches(steps), { a: 'b', b: 'b', c: 'c' });
});

test('a time keeps the steps agy made by then; a tool call keeps through its batch', () => {
  assert.equal(keptThrough(steps, { throughTime: '2026-11-24T11:00:05.000Z' }), 1);
  assert.equal(keptThrough(steps, { throughTime: '2026-11-24T11:00:20.000Z' }), undefined);
  assert.throws(() => keptThrough(steps, { throughTime: '2026-11-24T10:59:00.000Z' }), /keeps none/);
  assert.equal(keptThrough(steps, { throughToolCallId: 'a' }), 5);
  assert.equal(keptThrough(steps, { throughToolCallId: 'b' }), 5);
  assert.equal(keptThrough(steps, { throughToolCallId: 'c' }), 7);
  // The GUI cut after the batch's end; agy's own batch must end there too.
  assert.equal(keptThrough(steps, { throughToolCallId: 'a', batchEnd: 'b' }), 5);
  assert.throws(() => keptThrough(steps, { throughToolCallId: 'a', batchEnd: 'a' }), /ends at b, not at a/);
  assert.throws(() => keptThrough(steps, { throughToolCallId: 'gone' }), /no step for tool call gone/);
});

test('the language server port comes from the log agy writes for its pid', () => {
  assert.equal(languageServerPort('I1 server.go] Language server listening on random port at 62440 for HTTPS (gRPC)\n'
    + 'I1 server.go] Language server listening on random port at 62441 for HTTP\n'), 62441);
  assert.equal(languageServerPort('nothing yet'), undefined);
  assert.equal(agyLogDirectory(['acp', '--sandbox', '--agent', 'x'], '/home/u'), '/home/u/.gemini/antigravity-cli/log');
  assert.equal(agyLogDirectory(['acp', '--gemini-dir', '/p', '--app-data-dir', 'antigravity-acp'], '/home/u'),
    '/p/antigravity-acp/log');
});

test('a cut waits per session, a later one replaces it, and batches answer the GUI', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-native-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCut(dir, 's1', { throughTime: at(5) });
  await writeCut(dir, 's1', { throughToolCallId: 'a' });
  assert.deepEqual((await readCut(dir, 's1')).keep, { throughToolCallId: 'a' });
  assert.equal(await readCut(dir, 's2'), null);
  await assert.rejects(writeCut(dir, '../x', { throughTime: at(1) }), /Not an agy session id/);
  await writeBatches(dir, 's1', toolBatches(steps));
  assert.equal(await batchEnd(dir, 's1', 'a'), 'b');
  assert.equal(await batchEnd(dir, 's1', 'unknown'), undefined);
  assert.equal(await batchEnd(dir, 's9', 'a'), undefined);
});

/** A bridge wired to a scripted agy: it answers the bridge's own requests and records them. */
async function harness(t, { conversation = steps, onAgentRequest } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-native-'));
  const logDir = path.join(dir, 'log');
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, 'acp-server-20261124_110000-4242.log'),
    'Language server listening on random port at 7777 for HTTP\n');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const toAgentLog = [], toClientLog = [], calls = [], hidden = [];
  let stored = [...conversation];
  let native;
  const languageServer = (port) => {
    assert.equal(port, 7777);
    return {
      steps: async () => stored,
      revert: async (id, index) => { calls.push(['revert', id, index]); stored = stored.slice(0, index + 1); },
      fork: async (id, index) => { calls.push(['fork', id, index]); return 'forked-1'; },
    };
  };
  native = createAgyNative({ dir, logDir, pid: 4242, prefix: 'p-', languageServer, languageServerWaitMs: 200,
    toClient: (value) => toClientLog.push(value),
    toAgent: (value) => {
      toAgentLog.push(value);
      // agy answers the bridge's own requests; an update it sends meanwhile must stay hidden.
      queueMicrotask(async () => {
        await onAgentRequest?.(value);
        if (value.method === 'session/resume')
          hidden.push(await native.fromAgent({ jsonrpc: '2.0', method: 'session/update',
            params: { sessionId: value.params.sessionId, update: { sessionUpdate: 'available_commands_update' } } }));
        await native.fromAgent({ jsonrpc: '2.0', id: value.id, result: {} });
      });
    } });
  return { dir, native, toAgentLog, toClientLog, calls, hidden, stored: () => stored };
}

test('initialize advertises session/fork and native rewind to the client', async (t) => {
  const { native } = await harness(t);
  const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  assert.equal(await native.fromClient(request), request);
  const answer = await native.fromAgent({ jsonrpc: '2.0', id: 1, result: { agentCapabilities: {
    loadSession: true, sessionCapabilities: { resume: {} }, _meta: { antigravity: { tier: true } } } } });
  assert.deepEqual(answer.result.agentCapabilities.sessionCapabilities, { resume: {}, fork: {} });
  assert.deepEqual(answer.result.agentCapabilities._meta, { antigravity: { tier: true }, rubato: { nativeRewind: true } });
});

test('an open session lands its cut before the next prompt and keeps the client settings', async (t) => {
  const { dir, native, toAgentLog, calls, hidden, stored } = await harness(t);
  const load = { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's1', cwd: '/w', mcpServers: [{ name: 'rubato' }] } };
  assert.equal(await native.fromClient(load), load);
  await native.fromAgent({ jsonrpc: '2.0', id: 2, result: {} });
  // agy took the mode and refused a model; only what it took comes back after the cut.
  await native.fromClient({ jsonrpc: '2.0', id: 3, method: 'session/set_mode', params: { sessionId: 's1', modeId: 'plan' } });
  await native.fromAgent({ jsonrpc: '2.0', id: 3, result: {} });
  await native.fromClient({ jsonrpc: '2.0', id: 4, method: 'session/set_model', params: { sessionId: 's1', modelId: 'nope' } });
  await native.fromAgent({ jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'unknown model' } });
  await writeCut(dir, 's1', { throughTime: '2026-11-24T11:00:05.000Z' });
  toAgentLog.length = 0;
  const prompt = { jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } };
  assert.equal(await native.fromClient(prompt), prompt);
  assert.deepEqual(hidden, [null]);
  assert.deepEqual(calls, [['revert', 's1', 1]]);
  assert.equal(stored().length, 2);
  assert.deepEqual(toAgentLog.map((wire) => wire.method), ['session/close', 'session/resume', 'session/set_mode']);
  assert.deepEqual(toAgentLog[1].params, { sessionId: 's1', cwd: '/w', mcpServers: [{ name: 'rubato' }] });
  assert.equal(await readCut(dir, 's1'), null);
  // Nothing waits, so the next prompt goes straight on.
  toAgentLog.length = 0;
  await native.fromClient({ ...prompt, id: 6 });
  assert.deepEqual(toAgentLog, []);
});

test('a closed session opens without replay, lands its cut and closes before the client loads it', async (t) => {
  const { dir, native, toAgentLog, calls } = await harness(t);
  await writeCut(dir, 's1', { throughToolCallId: 'a' });
  const load = { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's1', cwd: '/w', mcpServers: [] } };
  assert.equal(await native.fromClient(load), load);
  assert.deepEqual(toAgentLog.map((wire) => wire.method), ['session/resume', 'session/close']);
  assert.deepEqual(calls, [['revert', 's1', 5]]);
});

test('session/fork copies through the kept turn and resumes the copy under the client request', async (t) => {
  const { native, toAgentLog, calls } = await harness(t);
  const fork = { jsonrpc: '2.0', id: 7, method: 'session/fork', params: { sessionId: 's1', cwd: '/w', mcpServers: [],
    _meta: { rubato: { keepThroughTime: '2026-11-24T11:00:05.000Z' } } } };
  const sent = await native.fromClient(fork);
  assert.deepEqual(calls, [['fork', 's1', 1]]);
  assert.deepEqual(toAgentLog.map((wire) => wire.method), ['session/resume', 'session/close']);
  assert.deepEqual(sent, { jsonrpc: '2.0', id: 7, method: 'session/resume', params: { sessionId: 'forked-1', cwd: '/w', mcpServers: [] } });
  // The copy is open once agy answers, and a fork without a kept turn copies all of it.
  await native.fromAgent({ jsonrpc: '2.0', id: 7, result: { sessionId: 'forked-1' } });
  await native.fromClient({ jsonrpc: '2.0', id: 8, method: 'session/fork', params: { sessionId: 'forked-1', cwd: '/w' } });
  assert.deepEqual(calls.at(-1), ['fork', 'forked-1', steps.length - 1]);
});

test('a cut that cannot land fails the client request instead of running on the old conversation', async (t) => {
  const { dir, native, toClientLog } = await harness(t);
  await writeCut(dir, 's1', { throughToolCallId: 'gone' });
  const prompt = { jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } };
  assert.equal(await native.fromClient(prompt), null);
  assert.equal(toClientLog.at(-1).id, 9);
  assert.match(toClientLog.at(-1).error.message, /no step for tool call gone/);
  assert.notEqual(await readCut(dir, 's1'), null);
  assert.deepEqual((await readdir(dir)).toSorted(), ['cuts', 'log']);
});

test('a cut written while another lands is not cleared with it; it lands next', async (t) => {
  let h, rewrote = false;
  h = await harness(t, { onAgentRequest: async (request) => {
    // While the first cut lands, the GUI writes a stricter one.
    if (request.method === 'session/close' && !rewrote) {
      rewrote = true;
      await writeCut(h.dir, 's1', { throughTime: '2026-11-24T11:00:01.500Z' });
    }
  } });
  await writeCut(h.dir, 's1', { throughTime: '2026-11-24T11:00:05.000Z' });
  const load = { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's1', cwd: '/w', mcpServers: [] } };
  assert.equal(await h.native.fromClient(load), load);
  assert.deepEqual(h.calls, [['revert', 's1', 1], ['revert', 's1', 0]]);
  assert.equal(await readCut(h.dir, 's1'), null);
});

test('a reply\'s end reaches the client only after its batches are saved', async (t) => {
  const h = await harness(t);
  const load = { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's1', cwd: '/w', mcpServers: [] } };
  await h.native.fromClient(load);
  await h.native.fromAgent({ jsonrpc: '2.0', id: 2, result: {} });
  const usage = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'usage_update' } } };
  assert.equal(await h.native.fromAgent(usage), usage);
  assert.equal(await batchEnd(h.dir, 's1', 'a'), 'b');
});

test('clearing a landed cut leaves a cut written between its read and its clearing', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-native-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCut(dir, 's1', { throughTime: at(5) });
  const landed = await readCut(dir, 's1');
  await new Promise((resolve) => setTimeout(resolve, 2));
  await writeCut(dir, 's1', { throughTime: at(1) });
  await clearCut(dir, 's1', landed);
  assert.deepEqual((await readCut(dir, 's1'))?.keep, { throughTime: at(1) });
  await clearCut(dir, 's1', await readCut(dir, 's1'));
  assert.equal(await readCut(dir, 's1'), null);
});

test('cuts written in one millisecond land in the order they were written', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-native-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let round = 0; round < 50; round++) {
    await writeCut(dir, 's1', { throughTime: at(5) });
    await writeCut(dir, 's1', { throughTime: at(1) });
    const latest = await readCut(dir, 's1');
    assert.deepEqual(latest.keep, { throughTime: at(1) });
    await clearCut(dir, 's1', latest);
  }
});

test('a waiting cut that cannot be read fails instead of passing as none', async (t) => {
  const { dir, native, toClientLog } = await harness(t);
  await mkdir(path.join(dir, 'cuts', 's1'), { recursive: true });
  await writeFile(path.join(dir, 'cuts', 's1', '999999999999999-000000001-x.json'), '{ not json');
  const prompt = { jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } };
  assert.equal(await native.fromClient(prompt), null);
  assert.match(toClientLog.at(-1).error.message, /could not be read/);
});

test('a cut folder that cannot be listed fails instead of passing as none', async (t) => {
  const { dir, native, toClientLog } = await harness(t);
  await writeCut(dir, 's1', { throughTime: at(5) });
  const folder = path.join(dir, 'cuts', 's1');
  await chmod(folder, 0o000);
  const prompt = { jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } };
  try {
    assert.equal(await native.fromClient(prompt), null);
  } finally {
    await chmod(folder, 0o700);
  }
  assert.match(toClientLog.at(-1).error.message, /could not be read/);
});
