// A conversation the engine starts and runs on its own (a lead Segno opened with session_create,
// a scheduled run) must show in the app as running while it runs, its turns arriving as they
// happen, and finish like any thread. Seen on 2026-10-20 (user 4c2a0df1): Segno's lead 01a15a0a…
// ran 16:00:28–16:13Z in the engine, while its imported thread showed "완료됨" and only the first
// message, because nothing followed the session after the import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { SESSION_MESSAGE_TYPE } from '../src/events.mjs';

const at = (second) => Date.parse('2026-10-20T16:00:00Z') + second * 1000;
const opening = { role: 'custom', customType: SESSION_MESSAGE_TYPE, display: true, content: '<session_message>', timestamp: at(29),
  details: { v: 1, messageId: 'm1', kind: 'message', from: { sessionId: 'segno', title: 'Segno', cwd: '/home' }, text: '운영 알림 조사해 줘' } };
const said = (text, second, stopReason = 'stop') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }], timestamp: at(second),
  provider: 'anthropic', model: 'claude' });

/** A fake engine session the follower attaches to: `push(events, status)` publishes, like Pi's replicated state. */
function engine() {
  const session = { messages: [opening], listener: null, sequence: 0, attached: 0, detached: 0, closed: 0, status: 'running' };
  session.push = (events, status = session.status) => {
    session.status = status;
    const records = events.map((event) => ({ sequence: ++session.sequence, event }));
    for (const { event } of records) if (event.type === 'message_end') session.messages.push(event.message);
    session.listener?.({ runtimeId: 'r1', sequence: session.sequence, status, events: records });
  };
  session.socket = { connected: true };
  session.connect = async () => ({
    client: session.socket,
    async attach(id) { assert.equal(id, 'S1'); session.attached += 1; },
    async detach() { session.detached += 1; },
    async close() { session.closed += 1; },
    async subscribeSession(listener) {
      session.listener = listener;
      listener({ runtimeId: 'r1', sequence: session.sequence, status: session.status, events: [] });
      return async () => { session.listener = null; };
    },
    async command(record) {
      if (record.type !== 'get_messages') return undefined;
      if (session.failReads > 0) { session.failReads -= 1; throw new Error('socket reset'); }
      return { messages: [...session.messages] };
    },
  });
  return session;
}

/** The T3 side: the thread the inventory imported (its first message only), and the runs written into it. */
function thread() {
  const t3 = { messages: [{ id: 'imported-0', role: 'user', text: '운영 알림 조사해 줘', runId: null, createdAt: new Date(at(29)).toISOString() }],
    runs: [] };
  t3.hooks = {
    projectedThread: async (threadId) => (threadId === 'T1' ? { messages: t3.messages, checkpoints: [] } : null),
    appendSessionMessage: async (_threadId, item) => {
      t3.messages.push({ id: item.id, role: item.context?.records?.[0]?.payload?.role ?? item.role, text: item.text, runId: item.runId ?? null,
        createdAt: item.createdAt });
    },
  };
  t3.openEngineRun = async (threadId, request) => { const run = { id: `run-${t3.runs.length + 1}`, threadId, status: 'running', ...request }; t3.runs.push(run); return run.id; };
  t3.closeEngineRun = async (_threadId, runId, status) => { t3.runs.find((run) => run.id === runId).status = status; };
  return t3;
}

const until = async (predicate, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 10)); }
  return predicate();
};

function setup(t, { companion = false } = {}) {
  const session = engine();
  const t3 = thread();
  const bridge = new RubatoPiBridge({ descriptorPath: '/nonexistent/descriptor.json', instanceId: 'rubato-test', ...t3.hooks });
  bridge.openEngineRun = t3.openEngineRun;
  bridge.closeEngineRun = t3.closeEngineRun;
  bridge.engineConnect = session.connect;
  bridge.engineRunThrottleMs = 0;
  bridge.engineRunWatchMs = 10;
  bridge.engineRunIdleGraceMs = 60;
  bridge.engineRunRetryMs = { beforeClose: [5, 5], afterEnd: [20, 20] };
  bridge.transcript = async () => ({ messages: [...session.messages] });
  bridge.companionSession = async () => companion;
  t.after(() => bridge.close());
  return { bridge, session, t3 };
}

test("an engine-run conversation shows as running, gets each reply as it lands, and finishes; then the follower lets the session go", async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  assert.equal(t3.runs.length, 1, 'a run that is going shows as running at once');
  assert.equal(t3.runs[0].status, 'running');
  session.push([{ type: 'message_end', message: said('알림 길은 대충 그려졌어.', 62, 'toolUse') }]);
  assert.ok(await until(() => t3.messages.some((message) => message.text === '알림 길은 대충 그려졌어.')), 'a reply arrives while the run goes on');
  assert.equal(t3.messages.at(-1).runId, 'run-1');
  assert.equal(t3.messages.at(-1).role, 'assistant');
  session.push([{ type: 'message_end', message: said('조사 끝났어.', 716) }, { type: 'agent_end' }, { type: 'agent_settled' }], 'idle');
  assert.ok(await until(() => t3.runs[0].status === 'completed'), 'the run completes when the engine settles');
  assert.deepEqual(t3.messages.map((message) => message.text), ['운영 알림 조사해 줘', '알림 길은 대충 그려졌어.', '조사 끝났어.'], 'each once, in order');
  assert.ok(await until(() => session.detached === 1 && session.closed === 1), 'no hold on an idle session');
  assert.equal(bridge.engineFollowers.size, 0);
});

test("one follower per conversation; none for Segno's own, none while T3 itself streams the thread, none for a session at rest", async (t) => {
  const { bridge, session, t3 } = setup(t);
  await Promise.all([bridge.followEngineRun('T1', 'S1'), bridge.followEngineRun('T1', 'S1')]);
  assert.equal(session.attached, 1);
  assert.equal(t3.runs.length, 1);

  const segno = setup(t, { companion: true });
  await segno.bridge.followEngineRun('T1', 'S1');
  assert.equal(segno.session.attached, 0);

  const streamed = setup(t);
  streamed.bridge.rpcConnections.add({ threadId: 'T1', sessionId: 'S1', closed: false, close: async () => {} });
  await streamed.bridge.followEngineRun('T1', 'S1');
  assert.equal(streamed.session.attached, 0);

  const resting = setup(t);
  resting.session.status = 'idle';
  await resting.bridge.followEngineRun('T1', 'S1');
  assert.equal(resting.t3.runs.length, 0, 'nothing runs, so nothing shows as running');
  assert.ok(await until(() => resting.session.detached === 1), 'and the follower lets go at once');
});

test('a new turn the engine starts while followed opens a run of its own after the last one finished', async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  session.push([{ type: 'message_end', message: said('첫 턴 끝.', 40) }, { type: 'agent_settled' }], 'running');
  assert.ok(await until(() => t3.runs[0].status === 'completed'));
  session.push([{ type: 'agent_start' }, { type: 'message_end', message: { ...opening, timestamp: at(50), details: { ...opening.details, messageId: 'm2', text: '하나 더' } } },
    { type: 'message_end', message: said('두 번째 턴 끝.', 55) }, { type: 'agent_settled' }], 'idle');
  assert.ok(await until(() => t3.runs.length === 2 && t3.runs[1].status === 'completed'));
  assert.equal(t3.messages.find((message) => message.text === '두 번째 턴 끝.').runId, 'run-2');
});

test('when the thread already runs a turn of T3\'s own, the follower writes nothing and leaves', async (t) => {
  const { bridge, session, t3 } = setup(t);
  bridge.openEngineRun = async () => null;
  await bridge.followEngineRun('T1', 'S1');
  session.push([{ type: 'message_end', message: said('T3가 직접 보여주는 답', 62) }]);
  assert.ok(await until(() => session.detached === 1));
  assert.deepEqual(t3.messages.map((message) => message.text), ['운영 알림 조사해 줘']);
});

test("a read of the session that fails at the end does not lose the run's last answer", async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  session.failReads = 1;
  session.push([{ type: 'message_end', message: said('최종 답이야.', 716) }, { type: 'agent_settled' }], 'idle');
  assert.ok(await until(() => t3.runs[0].status === 'completed'));
  assert.equal(t3.messages.at(-1).text, '최종 답이야.', 'in the thread before the run shows as finished');
  assert.equal(t3.messages.at(-1).runId, 'run-1');
});

test('when every read fails until the run closes, the answer still arrives afterwards from the stored conversation', async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  session.failReads = 100;
  session.push([{ type: 'message_end', message: said('늦게라도 와야 하는 답.', 716) }, { type: 'agent_settled' }], 'idle');
  assert.ok(await until(() => t3.runs[0].status === 'completed'), 'the run does not stay running forever');
  assert.ok(await until(() => session.detached === 1), 'and the session is let go');
  assert.ok(await until(() => t3.messages.some((message) => message.text === '늦게라도 와야 하는 답.')), 'the answer arrives without a stream');
});

test('a thread imported empty, before the engine was prompted, gets the prompt and every answer as they land', async (t) => {
  const { bridge, session, t3 } = setup(t);
  t3.messages.length = 0;
  session.messages.length = 0;
  session.status = 'idle';
  const followed = bridge.followEngineRun('T1', 'S1');
  session.status = 'running';
  await followed;
  await bridge.followEngineRun('T1', 'S1');
  const prompt = { role: 'user', content: [{ type: 'text', text: '매일 아침 점검해 줘' }], timestamp: at(30) };
  session.push([{ type: 'agent_start' }, { type: 'message_end', message: prompt }, { type: 'message_end', message: said('점검 시작할게.', 31, 'toolUse') }]);
  assert.ok(await until(() => t3.messages.some((message) => message.text === '점검 시작할게.')), 'the answer lands while the run goes on');
  assert.deepEqual(t3.messages.map((message) => [message.role, message.text, message.runId]),
    [['user', '매일 아침 점검해 줘', 'run-1'], ['assistant', '점검 시작할게.', 'run-1']]);
});

test('an older message the thread happens to lack is not written again by the follower; only what is newer than the thread', async (t) => {
  const { bridge, session, t3 } = setup(t);
  session.messages.unshift(said('아주 예전 답 (스레드에 다른 글자로 남은 것)', 1));
  await bridge.followEngineRun('T1', 'S1');
  session.push([{ type: 'message_end', message: said('새 답.', 62) }]);
  assert.ok(await until(() => t3.messages.some((message) => message.text === '새 답.')));
  assert.equal(t3.messages.some((message) => message.text.startsWith('아주 예전 답')), false);
});

test('closing the bridge also ends the retries of a follower that already let its session go', async (t) => {
  const { bridge, session, t3 } = setup(t);
  let reads = 0;
  bridge.transcript = async () => { reads += 1; throw new Error('engine gone'); };
  await bridge.followEngineRun('T1', 'S1');
  session.failReads = 100;
  session.push([{ type: 'message_end', message: said('못 읽은 답.', 716) }, { type: 'agent_settled' }], 'idle');
  assert.ok(await until(() => session.detached === 1 && bridge.engineFollowers.size === 0));
  await bridge.close();
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reads, after, 'no read after the bridge closed');
  assert.equal(t3.runs[0].status, 'completed');
});

test('a session whose worker dies mid-run ends its run as failed and is let go; one unloaded ends as interrupted', async (t) => {
  for (const [status, expected] of [['error', 'failed'], ['stored', 'interrupted']]) {
    const { bridge, session, t3 } = setup(t);
    await bridge.followEngineRun('T1', 'S1');
    session.push([{ type: 'message_end', message: said('하던 중', 62, 'toolUse') }]);
    assert.ok(await until(() => t3.messages.some((message) => message.text === '하던 중')));
    session.push([], status);
    assert.ok(await until(() => t3.runs[0].status === expected), `${status} → ${expected}`);
    assert.ok(await until(() => session.detached === 1 && bridge.engineFollowers.size === 0));
  }
});

test('an engine that goes away mid-run (crash or restart) ends the run as interrupted and lets go', async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  session.socket.connected = false;
  assert.ok(await until(() => t3.runs[0].status === 'interrupted'));
  assert.ok(await until(() => bridge.engineFollowers.size === 0));
});

test('a run waiting on an answer (the engine asks the person) is still going: it stays running and followed', async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  session.push([{ type: 'message_end', message: said('이거 지워도 돼?', 62, 'toolUse') }], 'waiting');
  assert.ok(await until(() => t3.messages.some((message) => message.text === '이거 지워도 돼?')));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(t3.runs[0].status, 'running');
  assert.equal(bridge.engineFollowers.size, 1);
  session.push([{ type: 'message_end', message: said('지웠어.', 70) }, { type: 'agent_settled' }], 'idle');
  assert.ok(await until(() => t3.runs[0].status === 'completed'));
});

test('answering the engine\'s confirm publishes idle for a moment; the run stays open and its last answer still lands', async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  session.push([{ type: 'message_end', message: said('지워도 돼?', 62, 'toolUse') }], 'waiting');
  session.push([], 'idle');
  session.push([], 'running');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(t3.runs[0].status, 'running', 'the moment of idle did not end it');
  session.push([{ type: 'message_end', message: said('지웠어, 끝.', 75) }, { type: 'agent_settled' }], 'idle');
  assert.ok(await until(() => t3.runs[0].status === 'completed'));
  assert.equal(t3.messages.at(-1).text, '지웠어, 끝.');
});

test('a run left open on a session that stays idle without settling ends as completed after a while', async (t) => {
  const { bridge, session, t3 } = setup(t);
  await bridge.followEngineRun('T1', 'S1');
  session.push([{ type: 'message_end', message: said('끝인데 정리 신호가 없다', 62) }], 'idle');
  assert.equal(t3.runs[0].status, 'running');
  assert.ok(await until(() => t3.runs[0].status === 'completed'));
  assert.ok(await until(() => bridge.engineFollowers.size === 0));
});
