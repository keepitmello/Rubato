import test from 'node:test';
import assert from 'node:assert/strict';
import { RubatoRpcConnection } from '../src/rpc-connection.mjs';

/** An engine attachment: commands answer from `answers`, state goes to the subscriber. */
function fakeClient(answers = {}) {
  const client = { client: { connected: true }, commands: [], replies: [], attached: [], listener: null,
    async attach(id) { client.attached.push(id); },
    async detach() { client.attached.push('detach'); },
    async subscribeSession(listener) { client.listener = listener; return async () => { client.listener = null; }; },
    async command(command) {
      client.commands.push(command);
      const answer = answers[command.type];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(command) : answer;
    },
    async reply(response) { client.replies.push(response); },
    async close() {},
  };
  return client;
}
function connection(client, bridge = {}, options = {}) {
  const records = [];
  const closed = [];
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(),
    viaInventory: async (call) => call({ create: async () => ({ sessionId: 'created-1' }) }), ...bridge },
  { threadId: 't1', cwd: '/work', onRecord: (record) => records.push(record), onClosed: (error) => closed.push(error),
    awaitTimings: { pollMs: 5, graceMs: 5 }, ...options });
  conn.client = client;
  return { conn, records, closed };
}

test('events before the attach are history; later ones arrive once, in order', async () => {
  const client = fakeClient();
  const { conn, records } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  assert.deepEqual(client.attached, ['s1']);
  client.listener({ runtimeId: 'r1', sequence: 2, status: 'idle', events: [{ sequence: 1, event: { type: 'old' } }, { sequence: 2, event: { type: 'old' } }] });
  client.listener({ runtimeId: 'r1', sequence: 4, status: 'running', events: [{ sequence: 2, event: { type: 'old' } }, { sequence: 3, event: { type: 'agent_start' } }, { sequence: 4, event: { type: 'message_start' } }] });
  client.listener({ runtimeId: 'r1', sequence: 4, status: 'running', events: [{ sequence: 4, event: { type: 'message_start' } }] });
  await conn.inbound;
  assert.deepEqual(records.map((record) => record.type), ['agent_start', 'message_start']);
});

test('a reloaded runtime starts its sequence over', async () => {
  const client = fakeClient();
  const { conn, records } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 9, status: 'idle', events: [] });
  client.listener({ runtimeId: 'r2', sequence: 2, status: 'running', events: [{ sequence: 1, event: { type: 'agent_start' } },
    { sequence: 2, event: { type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 1 } } }] });
  await conn.inbound;
  assert.deepEqual(records.map((record) => record.type), ['agent_start', 'message_start']);
});

test('new_session creates through the engine and the native id is the session id', async () => {
  const client = fakeClient({ get_state: { sessionId: 'created-1', sessionFile: '/sessions/x_created-1.jsonl', isStreaming: false } });
  const prompt = { label: 'p', text: 'You are p' };
  let createdWith;
  const { conn } = connection(client, { pendingPrompts: new Map([['t1', prompt]]),
    viaInventory: async (call) => call({ create: async (options) => { createdWith = options; return { sessionId: 'created-1' }; } }) });
  assert.deepEqual(await conn.request({ type: 'new_session' }), { cancelled: false });
  assert.deepEqual(createdWith, { cwd: '/work', systemPrompt: prompt });
  assert.deepEqual(client.attached, ['created-1']);
  const state = await conn.request({ type: 'get_state', id: 'x' });
  assert.equal(state.sessionFile, 'created-1');
  assert.equal(state.rubatoSessionFile, '/sessions/x_created-1.jsonl');
  assert.ok(client.commands.every((command) => command.type === 'get_state' && command.id === undefined));
});

test('send answers on the event stream as an id-less response', async () => {
  const client = fakeClient({ prompt: { disposition: 'started' }, steer: new Error('Interrupt the current turn') });
  const { conn, records } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  conn.send({ type: 'prompt', message: 'hi', streamingBehavior: 'steer' });
  conn.send({ type: 'steer', message: 'more' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records, [
    { type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } },
    { type: 'response', command: 'steer', success: false, error: 'Interrupt the current turn' },
  ]);
});

test('a dialog answer goes to the engine reply, not a command', async () => {
  const client = fakeClient();
  const { conn } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  conn.send({ type: 'extension_ui_response', id: 'q1', confirmed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.replies, [{ id: 'q1', confirmed: true }]);
  assert.equal(client.commands.some((command) => command.type === 'extension_ui_response'), false);
});

test('an unloaded session closes the stream with a reason', async () => {
  const client = fakeClient();
  const { conn, closed } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'unloaded', events: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed.length, 1);
  assert.match(closed[0].message, /was unloaded/);
});

// The adapter's first registration sends get_state before any lifecycle command: a
// `pi --mode rpc` process starts inside a fresh session (provider-pi adapter registerThread).
test('the first command with nothing attached opens a new session', async () => {
  const client = fakeClient({ get_state: { sessionId: 'created-1', sessionFile: '/s/created-1.jsonl' } });
  const { conn } = connection(client);
  const state = await conn.request({ type: 'get_state' });
  assert.equal(state.sessionFile, 'created-1');
  assert.deepEqual(client.attached, ['created-1']);
});

test('a thread that already ran in a session reattaches to it instead of starting over', async () => {
  const client = fakeClient({ get_state: { sessionId: 'old-1', sessionFile: '/s/old-1.jsonl' } });
  let created = 0;
  const { conn } = connection(client, { descriptor: { serverId: 'engine-a' },
    boundSession: async (threadId) => (threadId === 't1' ? { sessionId: 'old-1', serverId: 'engine-a' } : null),
    viaInventory: async (call) => call({ create: async () => { created += 1; return { sessionId: 'created-1' }; } }) });
  assert.equal((await conn.request({ type: 'get_state' })).sessionFile, 'old-1');
  assert.deepEqual(client.attached, ['old-1']);
  assert.equal(created, 0);
  // A later registration on the same connection asks for a fresh conversation.
  await conn.request({ type: 'new_session' });
  assert.deepEqual(client.attached, ['old-1', 'detach', 'created-1']);
});

test('a binding from another engine profile is not followed', async () => {
  const client = fakeClient({ get_state: { sessionId: 'created-1' } });
  const { conn } = connection(client, { descriptor: { serverId: 'engine-b' },
    boundSession: async () => ({ sessionId: 'old-1', serverId: 'engine-a' }) });
  await conn.request({ type: 'get_state' });
  assert.deepEqual(client.attached, ['created-1']);
});

test('a reattached session is recorded; one the engine lost falls back to a new session', async () => {
  const resumed = new Set();
  const client = fakeClient({ get_state: { sessionId: 'x' } });
  const attach = client.attach;
  client.attach = async (id) => { if (id === 'gone-1') throw new Error('Unknown session'); return attach(id); };
  const kept = connection(client, { resumedSessions: resumed, boundSession: async () => ({ sessionId: 'old-1', serverId: null }) });
  await kept.conn.request({ type: 'get_state' });
  assert.deepEqual([...resumed], ['old-1']);
  const lost = connection(fakeClient({ get_state: { sessionId: 'x' } }), { resumedSessions: resumed,
    boundSession: async () => ({ sessionId: 'gone-1', serverId: null }) });
  lost.conn.client.attach = client.attach;
  await lost.conn.request({ type: 'get_state' });
  assert.deepEqual([...resumed], ['old-1']);
  assert.deepEqual(client.attached, ['old-1', 'created-1']);
});

const settle = (conn, client, sequence, event) => {
  client.listener({ runtimeId: 'r1', sequence, status: 'idle', events: [{ sequence, event }] });
  return conn.inbound;
};
const until = async (predicate, ms = 1000) => {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((resolve) => setTimeout(resolve, 2)); }
};
async function attached(answers) {
  const client = fakeClient(answers);
  const made = connection(client);
  await made.conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  return { client, ...made };
}

// decisions/t3-turn-held-on-awaited-wake.md
test('a settle while a wake is awaited is held behind a wait row; the wake continues the turn', async () => {
  let waits = [{ id: 'bash_3', description: 'the unittest run' }];
  const { client, conn, records } = await attached({ get_awaited_wakes: () => ({ items: waits }) });
  await settle(conn, client, 1, { type: 'agent_settled' });
  assert.deepEqual(records.map((record) => record.type), ['tool_execution_start', 'tool_execution_update']);
  assert.equal(records[0].toolName, 'Waiting on background work');
  assert.match(records[1].partialResult.content[0].text, /Waiting on the unittest run/);
  waits = [];
  await settle(conn, client, 2, { type: 'agent_start' });
  assert.deepEqual(records.slice(2).map((record) => [record.type, record.isError ?? null]), [['tool_execution_end', false], ['agent_start', null]]);
  assert.equal(records.some((record) => record.type === 'agent_settled'), false);
});

test('a wait that ends without a wake lets the held settle through after the grace', async () => {
  let waits = [{ id: 'monitor_1' }];
  const { client, conn, records } = await attached({ get_awaited_wakes: () => ({ items: waits }) });
  await settle(conn, client, 1, { type: 'agent_settled' });
  waits = [];
  await until(() => records.some((record) => record.type === 'agent_settled'));
  assert.deepEqual(records.map((record) => record.type),
    ['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'agent_settled']);
});

test('nothing awaited, the settle passes at once', async () => {
  const { client, conn, records } = await attached({ get_awaited_wakes: () => ({ items: [] }) });
  await settle(conn, client, 1, { type: 'agent_settled' });
  assert.deepEqual(records.map((record) => record.type), ['agent_settled']);
});

test('Stop during a held wait ends the turn as interrupted', async () => {
  const { client, conn, records } = await attached({ get_awaited_wakes: () => ({ items: [{ id: 'bash_1', description: 'the build' }] }),
    abort: {}, get_state: { isStreaming: false, pendingMessageCount: 0 } });
  await settle(conn, client, 1, { type: 'agent_settled' });
  await conn.request({ type: 'abort' });
  const tail = records.slice(-2);
  assert.equal(tail[0].type, 'tool_execution_end');
  assert.equal(tail[0].isError, true);
  assert.deepEqual(tail[1], { type: 'agent_settled', aborted: true });
});

// decisions/t3-queued-message-vs-steer.md
test('a steer Pi never read comes back as a warning before the stopped turn settles', async () => {
  const { client, conn, records } = await attached({
    abort: {},
    get_state: { isStreaming: false, pendingMessageCount: 1, requestTimeline: { pendingInputs: [{ delivery: 'steer' }] } },
    clear_queue: { steering: ['also check the logs'], followUp: [] },
  });
  const stopping = conn.request({ type: 'abort' });
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'idle', events: [{ sequence: 1, event: { type: 'agent_settled', aborted: true } }] });
  await stopping;
  await conn.inbound;
  assert.deepEqual(records.map((record) => record.type), ['extension_ui_request', 'agent_settled']);
  assert.equal(records[0].method, 'notify');
  assert.match(records[0].message, /1 message never reached the model[\s\S]*1\. also check the logs/);
  assert.ok(client.commands.some((command) => command.type === 'clear_queue'));
});

import { activeBranch, replyBefore, stepBatch } from '../src/rpc-connection.mjs';
import { messageFingerprint } from '../../pi-runtime/features/conversation-rewind/rewind.mjs';
import { outlineEntry } from '../../pi-server/src/session-worker.mjs';
// Root → leaf: u1 a1 u2 a2 (a dropped side branch hangs off a1).
const tree = { leafId: 'a2', entries: [
  { id: 'u1', parentId: null, type: 'message', message: { role: 'user', timestamp: 1 } },
  { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', timestamp: 2, model: 'm' } },
  { id: 'x1', parentId: 'a1', type: 'message', message: { role: 'user', timestamp: 3 } },
  { id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', timestamp: 4 } },
  { id: 'a2', parentId: 'u2', type: 'message', message: { role: 'assistant', timestamp: 5, model: 'm' } },
] };

test('the cut T3 names by its first dropped entry is the reply before it, on the live branch', () => {
  const branch = activeBranch(tree);
  assert.deepEqual(branch.map((entry) => entry.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(replyBefore(branch, 'u2'), messageFingerprint(tree.entries[1].message));
  assert.equal(replyBefore(branch, 'u1'), null);
  assert.throws(() => replyBefore(branch, 'x1'), /not on this conversation's current branch/);
});

test('the engine\'s outline of a long session still names the rollback cut and the step batch', () => {
  const instructions = [{ type: 'thinking', thinking: 'x'.repeat(4096) }];
  const full = { leafId: tree.leafId, entries: tree.entries.map((entry) => entry.message?.role === 'assistant'
    ? { ...entry, message: { ...entry.message, content: [...instructions,
      { type: 'toolCall', id: `${entry.id}-call`, name: 'bash', arguments: { command: 'y'.repeat(4096) } }] } }
    : { ...entry }) };
  const outlined = { leafId: full.leafId, entries: full.entries.map(outlineEntry) };
  assert.equal(replyBefore(activeBranch(outlined), 'u2'), replyBefore(activeBranch(full), 'u2'));
  assert.deepEqual(stepBatch(activeBranch(outlined), 'a2-call'), ['a2-call']);
  assert.ok(JSON.stringify(outlined).length < JSON.stringify(full).length / 4);
});

test('a rollback rewinds the attached session in place instead of forking it', async () => {
  const { client, conn } = await attached({ get_entries: tree, rewind: {} });
  assert.deepEqual(await conn.request({ type: 'fork', entryId: 'u2' }), { cancelled: false });
  assert.deepEqual(client.commands.at(-1), { type: 'rewind', keep: [messageFingerprint(tree.entries[1].message)], skip: 0 });
  await conn.request({ type: 'fork', entryId: 'u1' });
  assert.deepEqual(client.commands.at(-1), { type: 'rewind', keep: [], skip: 0 });
  assert.equal(client.commands.some((command) => command.type === 'fork'), false);
});

test('the session name Rubato gives a conversation becomes the thread title', async () => {
  const titles = [];
  const client = fakeClient({ get_state: { sessionName: 'Port the work log' } });
  const { conn } = connection(client, { sessionTitle: async (threadId, title) => { titles.push([threadId, title]); } });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'idle', events: [{ sequence: 1, event: { type: 'session_info_changed', name: ' Renamed by topic ' } }] });
  await conn.inbound;
  assert.deepEqual(titles, [['t1', 'Port the work log'], ['t1', 'Renamed by topic']]);
});

test('the agent\'s own record keeping does not reach T3 as work', async () => {
  const { client, conn, records } = await attached({});
  client.listener({ runtimeId: 'r1', sequence: 2, status: 'running', events: [
    { sequence: 1, event: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'notes_write_file', args: { path: 'now.md' } } },
    { sequence: 2, event: { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'ls' } } },
  ] });
  await conn.inbound;
  assert.deepEqual(records.map((record) => record.toolCallId), ['c2']);
});

test('the continue words are Pi\'s continue only when the continue route marked the thread', async () => {
  const stepContinues = new Set();
  const { client, conn } = await attached({ prompt: { disposition: 'started' }, continue: {} });
  conn.bridge.stepContinues = stepContinues;
  const { STEP_CONTINUE_TEXT } = await import('../src/rpc-connection.mjs');
  await conn.request({ type: 'prompt', message: STEP_CONTINUE_TEXT });
  assert.deepEqual(client.commands.at(-1), { type: 'prompt', message: STEP_CONTINUE_TEXT });
  stepContinues.add('t1');
  await conn.request({ type: 'prompt', message: STEP_CONTINUE_TEXT });
  assert.deepEqual(client.commands.at(-1), { type: 'continue' });
  assert.equal(stepContinues.has('t1'), false);
});

test('any other prompt or a new conversation drops the continue mark', async () => {
  const stepContinues = new Set(['t1']);
  const { client, conn } = await attached({ prompt: { disposition: 'started' }, continue: {} });
  conn.bridge.stepContinues = stepContinues;
  const { STEP_CONTINUE_TEXT } = await import('../src/rpc-connection.mjs');
  await conn.request({ type: 'prompt', message: 'something else' });
  await conn.request({ type: 'prompt', message: STEP_CONTINUE_TEXT });
  assert.deepEqual(client.commands.at(-1), { type: 'prompt', message: STEP_CONTINUE_TEXT });
  stepContinues.add('t1');
  await conn.request({ type: 'new_session' });
  assert.equal(stepContinues.has('t1'), false);
});

test('reattaching the thread\'s session keeps a Continue on its way', async () => {
  const stepContinues = new Set(['t1']);
  const { client, conn } = await attached({ prompt: { disposition: 'started' }, continue: {} });
  conn.bridge.stepContinues = stepContinues;
  const { STEP_CONTINUE_TEXT } = await import('../src/rpc-connection.mjs');
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  await conn.request({ type: 'prompt', message: STEP_CONTINUE_TEXT });
  assert.deepEqual(client.commands.at(-1), { type: 'continue' });
});

test('reattaching to a session restores its agents and speed from the records the engine still holds', async () => {
  const { SessionStateFold } = await import('../src/session-state.mjs');
  const folds = new Map();
  const stateFor = (threadId, sessionId) => { if (!folds.has(threadId)) folds.set(threadId, new SessionStateFold({ threadId, sessionId })); return folds.get(threadId); };
  const client = fakeClient();
  const { conn } = connection(client, { stateFor });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 2, status: 'idle', events: [
    { sequence: 1, event: { type: 'extension_event', name: 'rubato.task.updated', data: { tasks: [{ task_id: 'st_a', status: 'completed', final_response: 'done' }] } } },
    { sequence: 2, event: { type: 'extension_event', name: 'rubato.speed.updated', data: { speed: 73 } } },
  ] });
  await conn.inbound;
  const state = folds.get('t1').snapshot();
  assert.equal(state.speedIndex, 73);
  assert.equal(state.agents[0].result, 'done');
});

test('the picker\'s reasoning effort and Fast reach Pi; an unchanged choice sends nothing again', async () => {
  const { client, conn } = await attached({ set_thinking_level: {}, get_service_tier: { supported: true, active: false }, prompt: { disposition: 'handled' } });
  const options = [{ id: 'reasoningEffort', value: 'high' }, { id: 'fastMode', value: true }];
  await conn.request({ type: 'rubato_selection', options });
  const sent = () => client.commands.filter((command) => !['get_service_tier', 'get_state', 'get_cache_warming'].includes(command.type));
  assert.deepEqual(sent(), [{ type: 'set_thinking_level', level: 'high' }, { type: 'prompt', message: '/fast on' }]);
  client.commands.length = 0;
  await conn.request({ type: 'rubato_selection', options: [{ id: 'reasoningEffort', value: 'high' }] });
  assert.deepEqual(sent(), []);
});

test('compact is Rubato\'s own /compact when the engine has it, upstream compact otherwise', async () => {
  const { client, conn } = await attached({
    get_commands: { commands: [{ name: 'compact', source: 'extension' }] }, prompt: { disposition: 'handled' } });
  await conn.request({ type: 'compact', customInstructions: 'keep the plan' });
  assert.deepEqual(client.commands.at(-1), { type: 'prompt', message: '/compact keep the plan' });
  assert.equal(client.commands.some((command) => command.type === 'compact'), false);
  const plain = await attached({ get_commands: { commands: [] }, compact: {} });
  await plain.conn.request({ type: 'compact' });
  assert.deepEqual(plain.client.commands.at(-1), { type: 'compact' });
});

test('a typed /rewind sends Pi nothing: T3 checks the count, then reverts the turns', async () => {
  const calls = [];
  const client = fakeClient({ prompt: { disposition: 'started' } });
  const { conn } = connection(client, {
    checkRewind: async (threadId, turns) => { calls.push(['check', threadId, turns]); if (turns > 2) throw new Error('This conversation has only 2 turns to rewind'); },
    rewindConversation: async (threadId, request) => { calls.push(['rewind', threadId, request.turns]); },
  });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  assert.deepEqual(await conn.request({ type: 'prompt', message: '/rewind 2' }), { disposition: 'handled' });
  await assert.rejects(conn.request({ type: 'prompt', message: '/rewind 3' }), /only 2 turns/);
  await assert.rejects(conn.request({ type: 'steer', message: '/rewind' }), /Interrupt the current turn/);
  assert.deepEqual(calls, [['check', 't1', 2], ['rewind', 't1', 2], ['check', 't1', 3]]);
  assert.equal(client.commands.some((command) => command.type === 'prompt' || command.type === 'steer'), false);
});

test('/name names the session and the thread; /reload reloads, neither is a prompt', async () => {
  const titles = [];
  const client = fakeClient({ set_session_name: {}, reload: {} });
  const { conn } = connection(client, { sessionTitle: async (threadId, title) => { titles.push([threadId, title]); } });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  await conn.request({ type: 'prompt', message: '/name Port review' });
  await conn.request({ type: 'prompt', message: '/reload' });
  assert.deepEqual(client.commands.filter((command) => command.type !== 'get_state' && command.type !== 'get_cache_warming'),
    [{ type: 'set_session_name', name: 'Port review' }, { type: 'reload' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(titles, [['t1', 'Port review']]);
});

test('a message another conversation sent reaches the thread once, from the attach history or live', async () => {
  const { SESSION_MESSAGE_TYPE } = await import('../src/events.mjs');
  const written = [];
  const client = fakeClient();
  const { conn } = connection(client, { appendSessionMessage: async (threadId, item) => { written.push([threadId, item]); } });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  const sent = (messageId, text) => ({ type: 'message_end', message: { role: 'custom', customType: SESSION_MESSAGE_TYPE, display: true,
    timestamp: 5, content: text, details: { messageId, text, kind: 'message', from: { sessionId: 'sender', title: 'Planner' } } } });
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'idle', events: [{ sequence: 1, event: sent('m1', 'from history') }] });
  client.listener({ runtimeId: 'r1', sequence: 3, status: 'running', events: [
    { sequence: 2, event: sent('m1', 'from history') }, { sequence: 3, event: sent('m2', 'live one') }] });
  await conn.inbound;
  assert.deepEqual(written.map(([threadId, item]) => [threadId, item.text, item.role]), [['t1', 'from history', 'user'], ['t1', 'live one', 'user']]);
  assert.equal(written[1][1].context.records[0].payload.from.sessionId, 'sender');
});

// pi-server drain.mjs: the engine says `restarting`, lets running tool calls finish, closes; the
// next engine continues the run and this stream carries the same turn across.
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
const restartTimings = { reconnectMs: 1000, retryMs: 5, resumeGraceMs: 30 };
async function runningStream(answers = {}) {
  const client = fakeClient(answers);
  const harness = connection(client, {}, { restartTimings });
  await harness.conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  // A turn the person started: the run's first input is their message.
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'running', events: [{ sequence: 1, event: { type: 'agent_start' } },
    { sequence: 1.5, event: { type: 'message_start', message: { role: 'user', content: 'go', timestamp: 1 } } }] });
  await harness.conn.inbound;
  return { client, ...harness };
}

test('a restart keeps the turn open and carries it to the next engine', async () => {
  const { client, conn, records, closed } = await runningStream();
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'running', restarting: true, events: [] });
  await conn.inbound;
  const row = records.find((record) => record.type === 'tool_execution_start' && record.toolName === 'Restarting Rubato');
  assert.ok(row, 'the turn says Rubato is restarting');
  // A message sent now waits for the next engine instead of reaching the closing one.
  conn.send({ type: 'prompt', message: 'later', streamingBehavior: 'steer' });
  await pause();
  assert.equal(client.commands.some((command) => command.type === 'prompt'), false);

  const next = fakeClient({ prompt: { disposition: 'started' } });
  conn.connectClient = async () => next;
  client.client.connected = false;
  await conn.reconnect();
  assert.deepEqual(next.attached, ['s1']);
  // The next engine continued the run: everything its new runtime published is this turn.
  next.listener({ runtimeId: 'r2', sequence: 2, status: 'running', events: [
    { sequence: 1, event: { type: 'agent_start' } }, { sequence: 2, event: { type: 'message_start' } }] });
  await pause();
  await conn.inbound;
  const types = records.map((record) => record.type);
  const end = records.findIndex((record) => record.type === 'tool_execution_end' && record.toolCallId === row.toolCallId);
  assert.ok(end > 0, 'the restart row closes');
  assert.match(records[end].result.content[0].text, /continues/);
  // The row closes, then the continued run arrives in the same turn.
  assert.deepEqual(types.slice(end).filter((type) => type !== 'response'), ['tool_execution_end', 'agent_start', 'message_start']);
  assert.ok(next.commands.some((command) => command.type === 'prompt' && command.message === 'later'), 'the waiting message went to the next engine');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(closed, []);
});

test('a run the next engine did not continue ends the turn with a reason', async () => {
  const { client, conn, closed } = await runningStream();
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'running', restarting: true, events: [] });
  const next = fakeClient({ get_state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });
  conn.connectClient = async () => next;
  await conn.reconnect();
  next.listener({ runtimeId: 'r2', sequence: 0, status: 'idle', events: [] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await conn.inbound;
  assert.equal(closed.length, 1);
  assert.match(closed[0].message, /did not pick up this reply/);
});

test('a turn that ends during the drain closes its row and is not waited on', async () => {
  const { client, conn, records, closed } = await runningStream();
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'running', restarting: true, events: [] });
  client.listener({ runtimeId: 'r1', sequence: 2, status: 'idle', restarting: true, events: [{ sequence: 2, event: { type: 'agent_settled' } }] });
  await conn.inbound;
  const types = records.map((record) => record.type);
  assert.ok(types.indexOf('tool_execution_end') < types.indexOf('agent_settled'), 'the row closes before the turn does');
  const next = fakeClient({ get_state: { isStreaming: false } });
  conn.connectClient = async () => next;
  await conn.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(closed, []);
});

test('the next engine not answering in time closes the stream with the reason', async () => {
  const { client, conn, closed } = await runningStream();
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'running', restarting: true, events: [] });
  conn.restartTimings = { ...restartTimings, reconnectMs: 30 };
  conn.connectClient = async () => { throw new Error('engine did not start'); };
  await conn.reconnect();
  assert.equal(closed.length, 1);
  assert.match(closed[0].message, /could not reach the new engine: engine did not start/);
});

test('T3\'s continuation after an app restart adopts a run still going instead of adding a message', async () => {
  const client = fakeClient({ get_state: { isStreaming: true }, prompt: { disposition: 'started' } });
  const { conn, records } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 3, status: 'running', events: [
    { sequence: 1, event: { type: 'agent_start' } },
    { sequence: 2, event: { type: 'message_start', message: { role: 'assistant' } } },
    { sequence: 3, event: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} } }] });
  conn.send({ type: 'prompt', message: 'Continue where you left off.', streamingBehavior: 'steer' });
  await pause();
  await conn.inbound;
  assert.equal(client.commands.some((command) => command.type === 'prompt'), false, 'no extra message reaches the model');
  assert.deepEqual(records.filter((record) => record.type !== 'response').map((record) => record.type),
    ['agent_start', 'message_start', 'tool_execution_start']);
  assert.deepEqual(records.find((record) => record.type === 'response'), { type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
});

test('T3\'s continuation on a session that is not running is an ordinary prompt', async () => {
  const client = fakeClient({ get_state: { isStreaming: false }, prompt: { disposition: 'started' } });
  const { conn } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  conn.send({ type: 'prompt', message: 'Continue where you left off.', streamingBehavior: 'steer' });
  await pause();
  assert.ok(client.commands.some((command) => command.type === 'prompt' && command.message === 'Continue where you left off.'));
});

// An engine that goes away without announcing a restart (killed, stopped without drain): T3 keeps
// this stream for the thread's next turn (ProviderSessionManager reuses a live session), so the
// stream must reach the next engine itself instead of failing "No session is attached".
test('an engine gone without a restart notice: the next message reaches the next engine on the same stream', async () => {
  const client = fakeClient();
  const { conn, closed } = connection(client, {}, { restartTimings });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  await conn.inbound;
  client.client.connected = false; // the socket closed; no `restarting` was published
  const next = fakeClient({ prompt: { disposition: 'started' } });
  conn.connectClient = async () => next;
  const answer = await conn.request({ type: 'prompt', message: '다음 말' });
  assert.deepEqual(answer, { disposition: 'started' });
  assert.deepEqual(next.attached, ['s1'], 'reattached on the next engine');
  assert.ok(next.commands.some((command) => command.type === 'prompt' && command.message === '다음 말'));
  assert.equal(client.commands.some((command) => command.type === 'prompt'), false, 'nothing went to the dead engine');
  assert.deepEqual(closed, []);
});

test('a client that came back to the next engine without its attachment is reattached before anything is sent', async () => {
  const client = fakeClient();
  client.client = { connected: true, attachment: { sessionId: 's1' } };
  const { conn, closed } = connection(client, {}, { restartTimings });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  client.client.attachment = undefined; // reconnected on the same socket path, attachment lost
  const next = fakeClient({ prompt: { disposition: 'started' } });
  next.client = { connected: true, attachment: { sessionId: 's1' } };
  conn.connectClient = async () => next;
  await conn.request({ type: 'prompt', message: 'hi' });
  assert.deepEqual(next.attached, ['s1']);
  assert.deepEqual(closed, []);
});

test('the watchdog also moves an idle stream to the next engine; one that never comes closes it with the reason', async () => {
  const client = fakeClient();
  const { conn, closed } = connection(client, {}, { restartTimings: { ...restartTimings, reconnectMs: 50 } });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  conn.watchdog = setInterval(() => { if (!conn.closed && !conn.reconnecting && conn.engineLost()) void conn.reachNextEngine(); }, 10);
  conn.connectClient = async () => { throw new Error('connect ENOENT'); };
  client.client.connected = false;
  for (let i = 0; i < 100 && closed.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  clearInterval(conn.watchdog);
  assert.equal(closed.length, 1);
  assert.match(String(closed[0]?.message ?? closed[0]), /could not reach the new engine/);
});

// The Agents panel's rows (session-state.mjs) hear an agent only through this stream, and the engine
// tells a change once. Seen 2026-10-25: T3 let an idle lead's stream go while its agent worked, the
// agent finished unheard, and the change had left the engine's buffer by the next attach, so the
// panel said "working · quiet 50m" for good.
import { SessionStateFold } from '../src/session-state.mjs';
import { RubatoPiBridge } from '../src/bridge.mjs';

const taskTick = (task) => ({ type: 'extension_event', name: 'rubato.task.updated', data: { parent_session_id: 's1', tasks: [task] } });
const working = { task_id: 'st_a', task_summary: 'Run the A/B', status: 'running', live_progress: { last_assistant_line: 'While that runs…' } };
const finished = { task_id: 'st_a', task_summary: 'Run the A/B', status: 'completed', residency_state: 'resident', final_response: 'Round 2 is done.' };
const answered = () => new Promise((resolve) => setTimeout(resolve, 5));
function foldedConnection(answers) {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  const client = fakeClient(answers);
  const { conn } = connection(client, { stateFor: () => fold });
  return { fold, client, conn, status: () => fold.snapshot().agents.find((agent) => agent.taskId === 'st_a')?.status };
}

test('an agent that finished while no stream watched reads finished once a stream attaches', async () => {
  const { client, conn, status } = foldedConnection({ get_task_snapshot: { parent_session_id: 's1', tasks: [finished] } });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  // All the buffer still holds is the agent at work.
  client.listener({ runtimeId: 'r1', sequence: 7, status: 'idle', events: [{ sequence: 7, event: taskTick(working) }] });
  await answered();
  assert.equal(status(), 'completed');
  assert.equal(client.commands.filter((command) => command.type === 'get_task_snapshot').length, 1);
});

test('a stretch of records the stream missed is made up by asking again; an engine that cannot answer changes nothing', async () => {
  const { client, conn, status } = foldedConnection({ get_task_snapshot: new Error('unknown extension request') });
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 1, status: 'idle', events: [{ sequence: 1, event: taskTick(working) }] });
  await answered();
  assert.equal(status(), 'running');
  client.answers = { get_task_snapshot: { parent_session_id: 's1', tasks: [finished] } };
  client.command = async (command) => { client.commands.push(command); return client.answers[command.type]; };
  client.listener({ runtimeId: 'r1', sequence: 400, status: 'idle', events: [{ sequence: 400, event: { type: 'message_end', message: { role: 'user', content: 'hi' } } }] });
  await answered();
  assert.equal(status(), 'completed');
});

test("T3 keeps a lead's stream while its agents work, and lets it go once they are done or only wait for mail", async (t) => {
  const bridge = new RubatoPiBridge({ descriptorPath: '/nonexistent/rubato-test.json', instanceId: 'rubato-test', backfillMs: 60_000 });
  t.after(() => bridge.close());
  const { fold, client, conn } = foldedConnection({ get_task_snapshot: { parent_session_id: 's1', tasks: [] } });
  client.detach = async () => {};
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  conn.fold = fold;
  bridge.rpcConnections.add(conn);
  fold.feed(taskTick(working));
  assert.equal(bridge.keepsStream('t1'), true);
  fold.feed(taskTick({ ...finished, member_turn: { state: 'resting', awaiting: [{ id: 'bg1', description: 'the wave' }] } }));
  assert.equal(bridge.keepsStream('t1'), true, 'resting on work of its own that will wake it');
  fold.feed(taskTick(finished));
  assert.equal(bridge.keepsStream('t1'), false);
});
