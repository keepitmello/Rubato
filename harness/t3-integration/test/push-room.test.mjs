// A companion's room tells push two things (push/service.mjs): that it is a room, so its runs are
// not thread alerts, and each thing the companion says live, so the phone hears it as a message.
// History brought back by a backfill is not news. Other threads tell push nothing.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { RubatoRpcConnection, T3_RESTART_CONTINUE_TEXT } from '../src/rpc-connection.mjs';
import { REPLY_TOOL } from '../../companion/home.mjs';
import { createGrantStore } from '../../push-relay/mac/grants.mjs';
import { createPushService, handlePushRequest } from '../src/push/service.mjs';

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

test("the bridge tells push whether a thread's newest run is one a companion opened", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-push-room-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let answer = null;
  const push = { companionRuns: (fn) => { answer = fn; return () => { answer = null; }; } };
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(dir, 'none.json'), instanceId: 'rubato-test', sessionStateDir: null, push });
  const session = (from, extra = {}) => ({ role: 'custom', customType: 'rubato-session-message', display: true,
    details: { v: 1, messageId: 'm', kind: 'message', text: 'brief', from, ...extra } });
  const segno = { sessionId: 'SEGNO', title: 'Segno', companion: true, companionId: 'segno' };
  const sibling = { sessionId: 'SIBLING', title: 'Sibling lead' };
  const notification = { role: 'custom', customType: 'senpi-terminal', details: {} };
  const restart = { role: 'user', content: [{ type: 'text', text: `${T3_RESTART_CONTINUE_TEXT} Your last turn was cut short.` }] };
  const transcripts = {
    'T-companion': [session(segno, { kind: 'create' }), { role: 'assistant', content: [] }],
    'T-person-after': [session(segno, { kind: 'create' }), { role: 'assistant', content: [] }, { role: 'user', content: '이거 이어서 해줘' }],
    'T-companion-again': [{ role: 'user', content: '이거 이어서 해줘' }, session(segno)],
    'T-clock': [session(segno, { kind: 'create' }), session({ title: 'Rubato' }, { kind: 'wake' })],
    'T-lead': [session({ sessionId: 'LEAD', title: 'Other lead' })],
    'T-unmarked': [session({ sessionId: 'ROO', title: 'Roo' })],
    'T-person': [{ role: 'user', content: 'hi' }],
    // Leads a companion created (2026-11-23: 92 of 279 finished runs in them were opened like these).
    'L-sibling': [session(segno, { kind: 'create' }), { role: 'assistant', content: [] }, session(sibling)],
    'L-woken': [session(sibling, { kind: 'create' }), { role: 'assistant', content: [] }, notification],
    'L-restart': [session(segno, { kind: 'create' }), { role: 'assistant', content: [] }, restart],
    'L-person': [session(segno, { kind: 'create' }), { role: 'assistant', content: [] }, { role: 'user', content: '이어 하자' }],
    'T-from-lead': [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }, session(sibling)],
    'T-person-restart': [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }, restart],
  };
  bridge.boundSession = async (threadId) => (transcripts[threadId] ? { sessionId: threadId, serverId: null } : null);
  bridge.transcript = async (sessionId) => ({ messages: transcripts[sessionId] });
  bridge.viaInventory = async (call) => call({ list: async () => [{ sessionId: 'ROO', companion: true, companionId: 'roo' },
    ...['SIBLING', 'L-sibling', 'L-woken', 'L-restart', 'L-person'].map((sessionId) => ({ sessionId, companionLead: true }))] });
  const asked = async (threadId) => answer(threadId);
  assert.equal(await asked('T-companion'), true);
  assert.equal(await asked('T-person-after'), false, "a turn the person sent in a lead the companion started is the person's to hear about");
  assert.equal(await asked('T-companion-again'), true);
  assert.equal(await asked('T-clock'), true, "Rubato's clock opens nothing of its own");
  assert.equal(await asked('T-lead'), false, "a lead the person started is not a companion's");
  assert.equal(await asked('T-unmarked'), true, 'a sender from before the mark is known by its session');
  assert.equal(await asked('T-person'), false);
  assert.equal(await asked('T-missing'), false);
  assert.equal(await asked('L-sibling'), true, "another lead's message to a companion's lead is still companion work");
  assert.equal(await asked('L-woken'), true, "a companion's lead woken by its own background work is companion work");
  assert.equal(await asked('L-restart'), true, "a restart's continue is not the person's");
  assert.equal(await asked('L-person'), true, 'typing into a companion lead does not turn its notifications back on');
  assert.equal(await asked('T-from-lead'), true, "a companion lead's message opens companion work in any thread");
  assert.equal(await asked('T-person-restart'), false, "a restart resumes the person's run");
  await bridge.close();
  assert.equal(answer, null, 'a closed bridge answers nothing');
});

test('a steer cannot change which iPhones hear about the run that just ended', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'rubato-push-opener-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const delivered = [];
  const grants = createGrantStore({ home, fetch: async (_url, init) => {
    delivered.push([init.headers.authorization, JSON.parse(init.body)]);
    return Response.json({ ok: true });
  } });
  for (const [deviceId, companionThreads] of [['quiet', false], ['loud', true]]) {
    grants.add({ relay: 'https://push.example.dev', grant: deviceId, grantId: deviceId, deviceId,
      preferences: { companionThreads, liveActivity: false } });
  }
  const now = Date.UTC(2026, 10, 23, 8, 9, 42);
  const push = createPushService({ home, grants, now: () => now, setTimer: () => null });
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(home, 'none.json'), instanceId: 'rubato-test', sessionStateDir: null, push });
  t.after(() => bridge.close());
  bridge.boundSession = async () => ({ sessionId: 'pi-lead', serverId: null });
  bridge.viaInventory = async (call) => call({ list: async () => [] });
  const sessionMessage = (timestamp, companion) => ({ timestamp, role: 'custom', customType: 'rubato-session-message',
    details: { kind: 'message', from: { companion } } });
  const messages = [sessionMessage(now - 60_000, true), sessionMessage(now - 1000, false)];
  bridge.transcript = async () => ({ messages });
  const startedAt = new Date(now - 59_950).toISOString();
  const awareness = (phase) => ({ threadId: 'lead', phase, updatedAt: new Date(now).toISOString(), threadTitle: 'Lead',
    headline: phase, environmentId: 'mac' });
  const change = async (phase, facts = {}) => push.threadChanged('lead', awareness(phase), { startedAt, ...facts });

  await change('running');
  await change('waiting_for_approval');
  await change('waiting_for_input');
  await change('completed');
  await change('running');
  await change('failed', { openedByPerson: true });
  assert.deepEqual(delivered.map(([phone, alert]) => [phone, alert.body]), [
    ['Bearer quiet', 'waiting_for_approval'], ['Bearer loud', 'waiting_for_approval'],
    ['Bearer quiet', 'waiting_for_input'], ['Bearer loud', 'waiting_for_input'],
    ['Bearer loud', 'completed'],
    ['Bearer quiet', '⚠︎ failed'], ['Bearer loud', '⚠︎ failed'],
  ]);
});

test("a companion-created lead stays quiet after a person's message, background wakes and restarts", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'rubato-push-lead-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const delivered = [];
  const grants = createGrantStore({ home, fetch: async (_url, init) => {
    delivered.push([init.headers.authorization, JSON.parse(init.body)]);
    return Response.json({ ok: true });
  } });
  for (const [deviceId, companionThreads] of [['quiet', false], ['loud', true]]) {
    grants.add({ relay: 'https://push.example.dev', grant: deviceId, grantId: deviceId, deviceId,
      preferences: { threads: true, companionThreads, liveActivity: false } });
  }
  const now = Date.UTC(2026, 10, 26, 20, 41, 25);
  const push = createPushService({ home, grants, now: () => now, setTimer: () => null });
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(home, 'none.json'), instanceId: 'rubato-test', sessionStateDir: null, push });
  t.after(() => bridge.close());
  bridge.boundSession = async () => ({ sessionId: 'companion-lead', serverId: null });
  bridge.viaInventory = async (call) => call({ list: async () => [{ sessionId: 'companion-lead', companionLead: true }] });
  const messages = [
    { role: 'custom', customType: 'rubato-session-message', timestamp: now - 120_000,
      details: { kind: 'create', from: { companion: true, companionId: 'segno' } } },
    { role: 'user', content: 'Use Astra instead.', timestamp: now - 60_000 },
  ];
  bridge.transcript = async () => ({ messages });
  const change = (phase, openedByPerson = false) => push.threadChanged('lead', {
    threadId: 'lead', phase, updatedAt: new Date(now).toISOString(), threadTitle: 'Companion lead',
    headline: phase, environmentId: 'mac',
  }, { startedAt: new Date(now - 1000).toISOString(), openedByPerson });

  // Even the actual user turn keeps the thread's chosen notification category.
  await change('running', true);
  await change('completed', true);
  messages.push({ role: 'custom', customType: 'senpi-terminal:notification', timestamp: now - 2000 });
  await change('running');
  await change('completed');
  messages.push({ role: 'user', content: `${T3_RESTART_CONTINUE_TEXT} Your last turn was cut short.`, timestamp: now - 1500 });
  await change('running');
  await change('failed');
  assert.deepEqual(delivered.map(([phone, alert]) => [phone, alert.body]), [
    ['Bearer loud', 'completed'], ['Bearer loud', 'completed'], ['Bearer loud', '⚠︎ failed'],
  ]);

  await handlePushRequest(push, new Request('http://mac/rubato/push/desktop-companion-threads', {
    method: 'POST', body: JSON.stringify({ enabled: false }),
  }));
  const muted = await handlePushRequest(push, new Request('http://mac/rubato/push/desktop-thread-muted', {
    method: 'POST', body: JSON.stringify({ threadId: 'lead' }),
  }));
  assert.deepEqual(await muted.json(), { muted: true }, 'desktop uses the same companion ownership');

  bridge.transcript = async () => { throw new Error('transcript unavailable'); };
  await change('running');
  await change('completed');
  assert.equal(delivered.at(-1)[0], 'Bearer loud', 'known ownership does not depend on reading the transcript');
  assert.equal(delivered.length, 4);
});
