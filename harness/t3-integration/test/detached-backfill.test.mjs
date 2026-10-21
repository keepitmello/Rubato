// Turns the engine runs while T3 has stopped a thread's provider session (its 30-minute idle stop)
// must still reach that thread: team mail, a lead ending, Segno's greetings. Seen on 2026-10-20:
// four wake-driven turns at 13:12–13:17Z never reached the lead's thread, and the user's next
// message at 14:42Z did not bring them back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { SESSION_MESSAGE_TYPE } from '../src/events.mjs';

const at = (minute) => Date.parse(`2026-10-20T13:${String(minute).padStart(2, '0')}:00Z`);
const user = (text, minute) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: at(minute) });
const said = (text, minute, stopReason = 'stop') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }], timestamp: at(minute),
  provider: 'anthropic', model: 'claude' });
const mail = (minute) => ({ role: 'custom', customType: 'rubato-runtime:wake', display: false, content: 'team mail', timestamp: at(minute) });
const clock = (minute) => ({ role: 'custom', customType: SESSION_MESSAGE_TYPE, display: false, content: 'tick', timestamp: at(minute),
  details: { v: 1, messageId: `wake-${minute}`, kind: 'wake', what: 'heartbeat', from: { sessionId: 'rubato', title: 'Rubato', cwd: '' }, text: 'tick' } });

/** A bridge whose engine and T3 thread are fakes: `session` is the engine's message list, `thread` what T3 shows. */
function setup(t, { session, thread, attached = false, gaps }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-backfill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  // What the bridge saved for the thread while it was attached; untouched since the idle stop.
  const stateFile = path.join(stateDir, `${encodeURIComponent('T1')}.json`);
  writeFileSync(stateFile, JSON.stringify({ sessionId: 'S1' }));
  utimesSync(stateFile, new Date(at(11)), new Date(at(11)));
  const appended = [];
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(dir, 'none.json'), instanceId: 'rubato-test', sessionStateDir: stateDir,
    backfillMs: 30,
    projectedThread: async (threadId) => (threadId === 'T1' ? { messages: [...thread, ...appended.map(([, item]) => ({ id: item.id,
      role: item.role, text: item.text, runId: item.runId ?? null, createdAt: item.createdAt }))], checkpoints: [] } : null),
    appendSessionMessage: async (threadId, item) => { appended.push([threadId, item]); } });
  bridge.viaInventory = async (call) => call({
    // The engine's list row (pi-server host.mjs): epoch-ms `modifiedAt` and `touchedAt`; the end-to-end test below reads a real one.
    list: async () => [{ sessionId: 'S1', cwd: '/w', title: 'lead', modifiedAt: session.at(-1).timestamp, touchedAt: session.at(-1).timestamp }],
    transcript: async (id) => ({ messages: id === 'S1' ? session : [] }),
  });
  if (gaps) bridge.streamGaps = async () => gaps;
  if (attached) bridge.rpcConnections.add({ threadId: 'T1', sessionId: 'S1', closed: false, close: async () => {} });
  t.after(() => bridge.close());
  return { bridge, appended };
}

const until = async (predicate, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 20)); }
  return predicate();
};

const before = [user('풀 해도 돼?', 40), said('응, 받아도 돼.', 41)];
const shownThread = [{ id: 'u', role: 'user', text: '풀 해도 돼?', runId: 'run-40', createdAt: new Date(at(40)).toISOString() },
  { id: 'a', role: 'assistant', text: '응, 받아도 돼.', runId: 'run-40', createdAt: new Date(at(41)).toISOString() }];

test('turns the engine ran after T3 stopped the idle session reach the thread on their own, in order, once', async (t) => {
  const session = [...before, mail(52), said('검증 통과를 확인할게.', 52, 'toolUse'), said('본 브랜치에 올라갔어.', 53),
    mail(57), said('세뇨 포팅이 다 끝났어.', 58)];
  const { appended } = setup(t, { session, thread: shownThread });
  assert.ok(await until(() => appended.length >= 3), 'the missed turns arrived without the user writing');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(appended.map(([threadId, item]) => [threadId, item.text]),
    [['T1', '검증 통과를 확인할게.'], ['T1', '본 브랜치에 올라갔어.'], ['T1', '세뇨 포팅이 다 끝났어.']],
    'every text once, in order');
  assert.equal(new Set(appended.map(([, item]) => item.id)).size, appended.length);
  assert.ok(appended.every(([, item]) => item.runId === 'run-40'), 'each goes into the run it followed, where T3 orders it');
});

test("Segno's thread gets back only what Segno said with reply after a time with no stream, never its monologue", async (t) => {
  const reply = (id, text, minute) => [
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: '혼잣말 메모.' }, { type: 'toolCall', id, name: 'reply', arguments: { text } }],
      timestamp: at(minute), provider: 'anthropic', model: 'claude' },
    { role: 'toolResult', toolCallId: id, toolName: 'reply', content: [{ type: 'text', text: 'Sent to the user.' }], isError: false, timestamp: at(minute) }];
  const session = [...before, clock(52), said('하트비트 혼잣말.', 52), ...reply('r1', '점심 먹었어?', 53), mail(57), said('리드 끝남 혼잣말.', 58)];
  const { bridge, appended } = setup(t, { session, thread: shownThread });
  bridge.companionSession = async () => true;
  assert.ok(await until(() => appended.length >= 1));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(appended.map(([, item]) => [item.text, item.ownRun === true]), [['점심 먹었어?', true]]);
});

test("with T3's record of when the thread had no stream, only messages from those times are written", async (t) => {
  const session = [...before, said('스트림이 있을 때 한 말.', 45), mail(52), said('본 브랜치에 올라갔어.', 53)];
  const { appended } = setup(t, { session, thread: shownThread, gaps: [{ from: at(50), to: at(55) }] });
  assert.ok(await until(() => appended.length >= 1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(appended.map(([, item]) => item.text), ['본 브랜치에 올라갔어.'],
    'a message from a time the stream was up is not the backfill\'s to write');
});

test('a thread with no gap in its stream is not read at all', async (t) => {
  let reads = 0;
  const session = [...before, said('본 브랜치에 올라갔어.', 53)];
  const { bridge, appended } = setup(t, { session, thread: shownThread, gaps: [] });
  const transcript = bridge.viaInventory;
  bridge.viaInventory = async (call) => transcript((client) => call({ ...client, transcript: async (id) => { reads += 1; return client.transcript(id); } }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(appended, []);
  assert.equal(reads, 0);
});

test('a session the engine-run follower is writing live is not read by the pass meanwhile', async (t) => {
  let reads = 0;
  const session = [...before, said('본 브랜치에 올라갔어.', 53)];
  const { bridge, appended } = setup(t, { session, thread: shownThread });
  bridge.engineFollowers = new Map([['S1', Promise.resolve({})]]);
  const transcript = bridge.viaInventory;
  bridge.viaInventory = async (call) => transcript((client) => call({ ...client, transcript: async (id) => { reads += 1; return client.transcript(id); } }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(reads, 0);
  bridge.engineFollowers.delete('S1');
  assert.ok(await until(() => appended.length >= 1), 'once the follower lets go, the pass compares the thread again');
});

test("a side chat's copied history, older than the thread itself, is never written into it", async (t) => {
  const session = [said('부모 대화에서 한 말.', 10), ...before, said('본 브랜치에 올라갔어.', 53)];
  const { appended } = setup(t, { session, thread: shownThread });
  assert.ok(await until(() => appended.length >= 1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(appended.map(([, item]) => item.text), ['본 브랜치에 올라갔어.']);
});

test('a thread T3 still has attached gets nothing from the backfill: the live stream carries it', async (t) => {
  const session = [...before, mail(52), said('본 브랜치에 올라갔어.', 53)];
  const { appended } = setup(t, { session, thread: shownThread, attached: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(appended, []);
});

test('when the thread shows nothing of the session to anchor on, nothing is guessed', async (t) => {
  const session = [...before, mail(52), said('본 브랜치에 올라갔어.', 53)];
  const { appended } = setup(t, { session, thread: [{ id: 'x', role: 'user', text: 'something else', turnId: 'x', createdAt: new Date(at(1)).toISOString() }] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(appended, []);
});

test('a stream attaching to the thread first writes what it missed, before it takes the session\'s new events', async () => {
  const { RubatoRpcConnection } = await import('../src/rpc-connection.mjs');
  const order = [];
  const client = { client: { connected: true }, async attach(id) { order.push(['attach', id]); }, async detach() {},
    async subscribeSession() { order.push(['subscribe']); return async () => {}; }, async command() { return undefined; }, async close() {} };
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(),
    backfillThread: async (threadId, sessionId) => { order.push(['backfill', threadId, sessionId]); },
    viaInventory: async () => undefined },
  { threadId: 'T1', cwd: '/w', onRecord: () => {}, onClosed: () => {}, awaitTimings: { pollMs: 5, graceMs: 5 } });
  conn.client = client;
  await conn.request({ type: 'switch_session', sessionPath: 'S1' });
  assert.deepEqual(order.slice(0, 3), [['backfill', 'T1', 'S1'], ['attach', 'S1'], ['subscribe']]);
});

test('a reply recovered after the user already wrote again goes into the run before, so it stands before their new message', async (t) => {
  const session = [...before, mail(52), said('본 브랜치에 올라갔어.', 53), user('왜 말을 안 해?', 58)];
  // The user's new message is in the thread already, in its own new run, when the backfill writes.
  const thread = [...shownThread, { id: 'u2', role: 'user', text: '왜 말을 안 해?', runId: 'run-41', createdAt: new Date(at(58)).toISOString() }];
  const { appended } = setup(t, { session, thread });
  assert.ok(await until(() => appended.length >= 1));
  assert.deepEqual(appended.map(([, item]) => [item.text, item.runId]), [['본 브랜치에 올라갔어.', 'run-40']],
    'run-40 sorts before run-41 in T3, whatever order the two were written in');
});

test('after a bubble T3 shows outside any run, a recovered reply still goes into the run before it', async (t) => {
  const bubble = { role: 'custom', customType: SESSION_MESSAGE_TYPE, display: true, content: 'mail', timestamp: at(50),
    details: { v: 1, messageId: 'm-50', kind: 'message', from: { sessionId: 'teammate', title: 'Teammate', cwd: '' }, text: '끝났어요' } };
  const session = [...before, bubble, said('받았어. 정리할게.', 51)];
  const thread = [...shownThread, { id: 'b', role: 'user', text: '끝났어요', runId: null, createdAt: new Date(at(50)).toISOString() }];
  const { appended } = setup(t, { session, thread });
  assert.ok(await until(() => appended.length >= 1));
  assert.deepEqual(appended.map(([, item]) => [item.text, item.runId]), [['받았어. 정리할게.', 'run-40']]);
});

test('every thread a stream attaches to is remembered for the backfill, with or without agents or a speed reading', async (t) => {
  const { readFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-backfill-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(dir, 'none.json'), instanceId: 'rubato-test', sessionStateDir: dir, backfillMs: 60_000 });
  t.after(() => bridge.close());
  bridge.stateFor('plain-chat', 'S9');
  const file = path.join(dir, `${encodeURIComponent('plain-chat')}.json`);
  for (let tries = 0; tries < 50 && !existsSync(file); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionId, 'S9');
});

// 2026-10-21 13:25Z: Segno's reply in a turn a messenger alert opened was in its sent record, but
// its thread showed it only at 13:32, when the user wrote "나한테 말을 안했어" and the stream
// attached. The pass that should have brought it read a field the engine's list never had.
test("Segno's reply sent while its thread has no stream reaches the thread through the engine's real list, without the user writing", async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { SessionFiles } = await import('../../pi-server/src/session-files.mjs');
  const { startSessionServer } = await import('../../pi-server/src/host.mjs');
  const { SessionClient } = await import('../../pi-server/src/client.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-backfill-engine-'));
  const sessionsDir = path.join(root, 'sessions');
  const socketPath = path.join(root, 'pi.sock');
  const service = await startSessionServer({ socketPath, sessionsDir, idleMs: null, pollMs: 50 });
  const client = await new SessionClient({ socketPath, serverId: service.serverId }).connect();
  t.after(async () => { await client.close(); await service.close(); await rm(root, { recursive: true, force: true }); });

  const created = await new SessionFiles(sessionsDir).create({ cwd: root, companion: true });
  const manager = SessionManager.open(created.file, sessionsDir);
  for (const message of [user('풀 해도 돼?', 40), said('응, 받아도 돼.', 41),
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: '혼잣말.' },
      { type: 'toolCall', id: 'r1', name: 'reply', arguments: { text: '운영방에서 어드민 느리다고 태그 왔어.' } }],
    timestamp: at(53), provider: 'anthropic', model: 'claude' },
    { role: 'toolResult', toolCallId: 'r1', toolName: 'reply', content: [{ type: 'text', text: 'Sent to the user.' }], isError: false, timestamp: at(53) },
    said('리드 띄웠어, 혼잣말.', 54)]) manager.appendMessage(message);

  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, `${encodeURIComponent('T1')}.json`), JSON.stringify({ sessionId: created.id }));
  const appended = [];
  // Segno's thread shows the person's own message only; the gap is T3's idle stop.
  const thread = [{ id: 'u', role: 'user', text: '풀 해도 돼?', runId: 'run-40', createdAt: new Date(at(40)).toISOString() }];
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(root, 'none.json'), instanceId: 'rubato-test', sessionStateDir: stateDir,
    backfillMs: 30,
    projectedThread: async (threadId) => (threadId === 'T1' ? { messages: thread, checkpoints: [] } : null),
    appendSessionMessage: async (threadId, item) => { appended.push([threadId, item]); } });
  bridge.viaInventory = async (call) => call(client);
  bridge.streamGaps = async () => [{ from: at(45), to: Number.MAX_SAFE_INTEGER }];
  t.after(() => bridge.close());

  assert.ok(await until(() => appended.length >= 1, 5000), 'the reply reached the thread on its own');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(appended.map(([threadId, item]) => [threadId, item.text, item.ownRun === true]),
    [['T1', '운영방에서 어드민 느리다고 태그 왔어.', true]], 'only the reply, once, in a run of its own so the phone hears of it');
});
