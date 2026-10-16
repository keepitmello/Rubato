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
  client.listener({ runtimeId: 'r2', sequence: 1, status: 'running', events: [{ sequence: 1, event: { type: 'agent_start' } }] });
  await conn.inbound;
  assert.deepEqual(records.map((record) => record.type), ['agent_start']);
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

import { activeBranch, replyBefore } from '../src/rpc-connection.mjs';
import { messageFingerprint } from '../../pi-runtime/features/conversation-rewind/rewind.mjs';
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
