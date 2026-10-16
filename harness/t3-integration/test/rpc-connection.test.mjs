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
function connection(client, bridge = {}) {
  const records = [];
  const closed = [];
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(),
    viaInventory: async (call) => call({ create: async () => ({ sessionId: 'created-1' }) }), ...bridge },
  { threadId: 't1', cwd: '/work', onRecord: (record) => records.push(record), onClosed: (error) => closed.push(error) });
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
  assert.deepEqual(records.map((record) => record.type), ['agent_start', 'message_start']);
});

test('a reloaded runtime starts its sequence over', async () => {
  const client = fakeClient();
  const { conn, records } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 9, status: 'idle', events: [] });
  client.listener({ runtimeId: 'r2', sequence: 1, status: 'running', events: [{ sequence: 1, event: { type: 'agent_start' } }] });
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
  assert.deepEqual(client.commands, [{ type: 'get_state' }]);
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
  assert.deepEqual(client.commands, []);
});

test('fork on an attached session is refused: it would move every window to the copy', async () => {
  const client = fakeClient();
  const { conn } = connection(client);
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  await assert.rejects(conn.request({ type: 'fork', entryId: 'e1' }), /forks conversations through the engine/);
  assert.deepEqual(client.commands, []);
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
