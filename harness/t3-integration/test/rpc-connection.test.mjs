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
