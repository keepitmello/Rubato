// Segno's thread is a chat log (intent companion-segno rev 11, user items 85727ce8, c31022f7): the
// person's own messages and what Segno says with reply or say, and nothing else from Segno's
// session — live, backfilled or imported. Any other conversation shows its turns as before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RubatoRpcConnection } from '../src/rpc-connection.mjs';
import { createCompanionStream } from '../src/companion-thread.mjs';
import { REPLY_TOOL } from '../../companion/home.mjs';

const wake = { role: 'custom', customType: 'rubato-session-message', display: false, content: '<rubato_wake>', timestamp: 1,
  details: { v: 1, messageId: 'w1', kind: 'wake', what: 'heartbeat', from: { sessionId: 'rubato', title: 'Rubato', cwd: '' }, text: 'tick' } };
const notice = { role: 'custom', customType: 'rubato-session-message', display: true, content: '<session_notice>', timestamp: 2,
  details: { v: 1, messageId: 'n1', kind: 'notice', from: { sessionId: 'lead', title: 'Login', cwd: '/w' }, text: 'Finished.' } };
const user = { role: 'user', content: '오늘 뭐 있어?', timestamp: 3 };
const thinking = { role: 'assistant', stopReason: 'toolUse', timestamp: 4,
  content: [{ type: 'thinking', thinking: '뭐라고 하지' }, { type: 'text', text: '혼잣말' }, { type: 'toolCall', id: 'b1', name: 'bash', arguments: {} }] };
const bashResult = { role: 'toolResult', toolCallId: 'b1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 5 };
const replyCall = (id, text, at = 6) => ({ role: 'assistant', stopReason: 'toolUse', timestamp: at,
  content: [{ type: 'toolCall', id, name: REPLY_TOOL, arguments: { text } }] });
const replyResult = (id, at = 7, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: REPLY_TOOL, isError, timestamp: at,
  content: [{ type: 'text', text: isError ? 'failed' : 'Sent to the user.' }] });
const final = { role: 'assistant', stopReason: 'stop', timestamp: 8, content: [{ type: 'text', text: '다 했다.' }] };
const reminder = { role: 'custom', customType: 'rubato-companion.reply-reminder', display: false, content: 'reply', timestamp: 9 };
const ui = { type: 'extension_ui_request', id: 'q1', method: 'confirm', title: '지울까?' };
const msg = (message) => [{ type: 'message_start', message }, { type: 'message_end', message }];
/** One Pi run as the engine publishes it. */
const run = (input, ...tail) => [{ type: 'agent_start' }, { type: 'turn_start' }, ...msg(input),
  ...tail.flatMap((item) => (item.type ? [item] : msg(item))), { type: 'turn_end' }, { type: 'agent_end', messages: [input, ...tail] }, { type: 'agent_settled' }];

/** A stream on a session the engine says is (or is not) Segno's, with a fake engine client. */
async function stream({ companion = true, messages = [] } = {}) {
  const commands = [];
  const client = { client: { connected: true }, listener: null, sequence: 0,
    async attach() {}, async subscribeSession(listener) { client.listener = listener; return async () => {}; },
    async command(command) {
      commands.push(command);
      if (command.type === 'prompt') return { disposition: 'started' };
      if (command.type === 'get_messages') return { messages };
      if (command.type === 'get_awaited_wakes') return { items: [] };
      return undefined;
    }, async reply() {}, async close() {} };
  const records = [];
  const appended = [];
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(),
    companionSession: async () => companion, appendSessionMessage: async (_threadId, item) => { appended.push(item); } },
  { threadId: 't1', cwd: '/w', onRecord: (record) => records.push(record), awaitTimings: { pollMs: 5, graceMs: 5, reminderMs: 60 } });
  conn.client = client;
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  const publish = async (events, status = 'idle') => {
    const from = client.sequence;
    client.sequence += events.length;
    client.listener({ runtimeId: 'r1', sequence: client.sequence, status, events: events.map((event, index) => ({ sequence: from + index + 1, event })) });
    await conn.inbound;
  };
  const shown = () => records.filter((record) => record.type !== 'response');
  return { conn, client, commands, records, appended, publish, shown };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a turn the person opened shows only its start, its end and a question for them; a reply is Segno's message and ends the turn", async () => {
  const s = await stream();
  await s.conn.request({ type: 'prompt', message: '오늘 뭐 있어?' });
  const notify = { type: 'extension_ui_request', id: 'n1', method: 'notify', message: '혼잣말 알림' };
  const status = { type: 'extension_ui_request', id: 's1', method: 'setStatus', statusText: '생각 중' };
  await s.publish([...run(user, thinking, bashResult, notify, status, ui, replyCall('r1', '3시에 회의 있어.'), replyResult('r1'), final)]);
  assert.deepEqual(s.shown().map((record) => record.type), ['agent_start', 'extension_ui_request', 'agent_settled']);
  assert.doesNotMatch(JSON.stringify(s.shown()), /혼잣말|뭐라고 하지|다 했다|bash|생각 중/);
  assert.deepEqual(s.appended.map((item) => [item.text, item.ownRun]), [['3시에 회의 있어.', true]]);
});

test('a turn T3 did not start (the clock, a lead ending) passes nothing; the person\'s message waits for it and opens its own turn', async () => {
  const s = await stream();
  await s.publish(run(notice, final));
  const clockRun = run(wake, thinking, bashResult, final);
  await s.publish(clockRun.slice(0, 5), 'running');
  const sending = s.conn.request({ type: 'prompt', message: '있어?' });
  await pause(20);
  assert.equal(s.commands.some((command) => command.type === 'prompt'), false, 'the message waits for Segno\'s own turn');
  await s.publish(clockRun.slice(5));
  await sending;
  assert.deepEqual(s.shown(), [], 'nothing of either turn reached the thread');
  assert.deepEqual(s.appended, [], 'not even the lead\'s message');
  await s.publish(run(user, replyCall('r2', '응, 여기 있어.'), replyResult('r2')));
  assert.deepEqual(s.shown().map((record) => record.type), ['agent_start', 'agent_settled']);
});

test("a turn the person opened that ends with no reply stays open for Segno's reminder, and ends with the reminder's turn", async () => {
  const s = await stream();
  await s.conn.request({ type: 'prompt', message: '오늘 뭐 있어?' });
  await s.publish(run(user, thinking, bashResult, final));
  await pause(10);
  assert.deepEqual(s.shown().map((record) => record.type), ['agent_start'], 'no reply yet: the turn is still Segno writing');
  await s.publish(run(reminder, replyCall('r3', '3시에 회의!'), replyResult('r3')));
  assert.deepEqual(s.shown().map((record) => record.type), ['agent_start', 'agent_start', 'agent_settled'], 'the reminder went on as the same turn');
  assert.deepEqual(s.appended.map((item) => item.text), ['3시에 회의!']);

  const late = await stream();
  await late.conn.request({ type: 'prompt', message: '?' });
  await late.publish(run(user, final));
  await pause(120);
  assert.deepEqual(late.shown().map((record) => record.type), ['agent_start', 'agent_settled'], 'a reminder that never comes lets the turn end');
  assert.equal(late.shown().at(-1).aborted, true, 'as stopped: a turn with no words for the person does not notify');
  assert.equal(s.shown().at(-1).aborted, undefined, 'a turn that replied ends as finished, and notifies');

  const silent = await stream();
  await silent.conn.request({ type: 'prompt', message: '?' });
  await silent.publish(run(user, final));
  await silent.publish(run(reminder, final));
  assert.deepEqual(silent.shown().map((record) => [record.type, record.aborted]), [['agent_start', undefined], ['agent_start', undefined], ['agent_settled', true]],
    'the reminder\'s turn said nothing either: stopped');

  const failed = await stream();
  await failed.conn.request({ type: 'prompt', message: '?' });
  await failed.publish(run(user, replyCall('r4', '보낼게'), replyResult('r4', 7, true), final));
  await pause(10);
  assert.deepEqual(failed.shown().map((record) => record.type), ['agent_start'], 'a reply that failed is no reply');
  assert.deepEqual(failed.appended, []);
});

test("the adapter's backfill (get_messages) of Segno's thread holds only the person's messages, and what Segno said comes as its message", async () => {
  const stored = [user, thinking, bashResult, replyCall('r5', '좋아!'), replyResult('r5'), final, notice, final];
  const s = await stream({ messages: stored });
  const reply = await s.conn.request({ type: 'get_messages' });
  assert.deepEqual(reply.messages, [user]);
  assert.deepEqual(s.appended.map((item) => item.text), ['좋아!']);
  const lead = await stream({ companion: false, messages: stored });
  assert.equal((await lead.conn.request({ type: 'get_messages' })).messages.length, stored.length, 'any other thread gets its whole conversation');
});

test('any other conversation shows its turns whole, the ones T3 did not start too, and the messages other conversations send', async () => {
  const s = await stream({ companion: false });
  const events = run(notice, thinking, bashResult, final);
  await s.publish(events);
  assert.deepEqual(s.shown().map((record) => record.type), events.map((event) => event.type));
  assert.deepEqual(s.appended.map((item) => item.text), ['Finished.']);
});

test('the filter on its own: a turn T3 holds open goes on in the same turn; an adopted run passes from there', () => {
  let owned = false;
  const filter = createCompanionStream({ owned: () => owned });
  assert.deepEqual(filter.accept({ type: 'agent_start' }), [], 'not T3\'s');
  assert.deepEqual(filter.accept({ type: 'agent_settled' }), []);
  owned = true;
  assert.equal(filter.accept({ type: 'agent_start' }).length, 1);
  assert.deepEqual(filter.accept({ type: 'message_end', message: final }), []);
  assert.deepEqual(filter.accept({ type: 'tool_execution_start', toolName: 'bash' }), []);
  assert.equal(filter.accept({ type: 'agent_settled' }).length, 1);
  owned = false;
  filter.attached(true);
  assert.deepEqual(filter.accept({ type: 'agent_settled' }), [], 'a turn going at attach is not this stream\'s');
  filter.attached(true);
  filter.adopt();
  assert.equal(filter.accept({ type: 'agent_settled' }).length, 1, 'T3 took the run over after an app restart');
});

test("T3's old V1 path refuses Segno's conversation: only the V2 stream keeps its thread a chat log", async () => {
  const { RubatoPiBridge } = await import('../src/bridge.mjs');
  const bridge = new RubatoPiBridge({ descriptorPath: '/nonexistent/descriptor.json', instanceId: 'rubato-test' });
  try {
    bridge.connection = async () => ({});
    bridge.descriptor = { serverId: 'srv' };
    bridge.companionSession = async (id) => id === 'segno';
    await assert.rejects(bridge.open({ threadId: 't', cwd: '/w', runtimeMode: 'full-access', resumeCursor: { kind: 'rubato-pi', serverId: 'srv', sessionId: 'segno' } }),
      /V2 stream/);
  } finally { await bridge.close(); }
});
