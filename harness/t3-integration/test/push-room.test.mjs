// A companion's room tells push two things (push/service.mjs): that it is a room, so its runs are
// not thread alerts, and each thing the companion says live, so the phone hears it as a message.
// History brought back by a backfill is not news. Other threads tell push nothing.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { RubatoRpcConnection } from '../src/rpc-connection.mjs';
import { REPLY_TOOL } from '../../companion/home.mjs';

const user = { role: 'user', content: '오늘 뭐 있어?', timestamp: 3 };
const replyCall = (id, text) => ({ role: 'assistant', stopReason: 'toolUse', timestamp: 6, content: [{ type: 'toolCall', id, name: REPLY_TOOL, arguments: { text } }] });
const replyResult = (id) => ({ role: 'toolResult', toolCallId: id, toolName: REPLY_TOOL, isError: false, timestamp: Date.UTC(2026, 10, 13, 12), content: [{ type: 'text', text: 'Sent to the user.' }] });
const msg = (message) => [{ type: 'message_start', message }, { type: 'message_end', message }];
const run = (input, ...tail) => [{ type: 'agent_start' }, ...msg(input), ...tail.flatMap(msg), { type: 'agent_end', messages: [input, ...tail] }, { type: 'agent_settled' }];

async function stream({ companion = true, messages = [] } = {}) {
  const told = { rooms: [], said: [] };
  const push = { companionRoom: (threadId, companionId) => told.rooms.push([threadId, companionId]),
    companionSaid: async (said) => { told.said.push(said); return null; } };
  const client = { client: { connected: true }, listener: null, sequence: 0,
    async attach() {}, async detach() {}, async subscribeSession(listener) { client.listener = listener; return async () => {}; },
    async command(command) {
      if (command.type === 'prompt') return { disposition: 'started' };
      if (command.type === 'get_messages') return { messages };
      if (command.type === 'get_awaited_wakes') return { items: [] };
      return undefined;
    }, async reply() {}, async close() {} };
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(), push,
    companionSession: async () => companion, companionIdOf: () => 'roo', appendSessionMessage: async () => {} },
  { threadId: 'room-roo', cwd: '/w', onRecord: () => {}, awaitTimings: { pollMs: 5, graceMs: 5, reminderMs: 60 } });
  conn.client = client;
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  const publish = async (events) => {
    const from = client.sequence;
    client.sequence += events.length;
    client.listener({ runtimeId: 'r1', sequence: client.sequence, status: 'idle', events: events.map((event, index) => ({ sequence: from + index + 1, event })) });
    await conn.inbound;
  };
  return { conn, told, publish };
}

test("a companion's room is noted once attached, and each live reply goes to push with its time", async () => {
  const s = await stream();
  assert.deepEqual(s.told.rooms, [['room-roo', 'roo']]);
  await s.conn.request({ type: 'prompt', message: '오늘 뭐 있어?' });
  await s.publish(run(user, replyCall('r1', '3시에 회의 있어.'), replyResult('r1')));
  assert.equal(s.told.said.length, 1);
  assert.deepEqual({ ...s.told.said[0], id: undefined }, { id: undefined, threadId: 'room-roo', companionId: 'roo', text: '3시에 회의 있어.',
    at: Date.UTC(2026, 10, 13, 12) });
  assert.ok(s.told.said[0].id);
});

test('a backfilled reply is history and is not pushed; an ordinary thread tells push nothing', async () => {
  const s = await stream({ messages: [user, replyCall('old', '예전 말'), replyResult('old')] });
  s.conn.backfillSaidEchoes([user, replyCall('old', '예전 말'), replyResult('old')]);
  assert.deepEqual(s.told.said, []);
  const plain = await stream({ companion: false });
  await plain.publish(run(user, replyCall('r9', 'x'), replyResult('r9')));
  assert.deepEqual([plain.told.rooms, plain.told.said], [[], []]);
});

test('the bridge remembers which companion a session is, and only the server bridge pushes', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-push-room-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(dir, 'none.json'), instanceId: 'rubato-test', sessionStateDir: null });
  t.after(() => bridge.close());
  bridge.viaInventory = async (call) => call({ list: async () => [{ sessionId: 'S1', companion: true, companionId: 'roo' }, { sessionId: 'S2', companion: true }] });
  assert.equal(await bridge.companionSession('S1'), true);
  assert.equal(bridge.companionIdOf('S1'), 'roo');
  assert.equal(bridge.companionIdOf('S2'), 'segno');
  assert.equal(bridge.companionIdOf('S3'), null);
  assert.equal(bridge.push, null, 'a bridge built bare pushes nothing');
});
