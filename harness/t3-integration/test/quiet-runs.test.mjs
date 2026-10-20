import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuietRuns, quietMessages } from '../src/quiet-runs.mjs';
import { RubatoRpcConnection } from '../src/rpc-connection.mjs';
import { QUIET_WAKES, sessionMessageFrom } from '../src/events.mjs';
import { WAKES } from '../../pi-runtime/features/session-link/message.mjs';

const wake = (what) => ({ role: 'custom', customType: 'rubato-session-message', display: false, content: '<rubato_wake>',
  details: { v: 1, messageId: `w-${what}`, kind: 'wake', what, from: { sessionId: 'rubato', title: 'Rubato', cwd: '' }, text: 'tick' }, timestamp: 1 });
const notice = { role: 'custom', customType: 'rubato-session-message', display: true, content: '<session_notice>',
  details: { v: 1, messageId: 'n', kind: 'notice', from: { sessionId: 'lead', title: 'Login', cwd: '/w' }, text: 'Finished.' }, timestamp: 2 };
const user = { role: 'user', content: 'hi', timestamp: 3 };
const answer = { role: 'assistant', content: [{ type: 'text', text: 'Heartbeat check: nothing has stalled.' }], timestamp: 4, stopReason: 'stop' };
const notesNudge = { role: 'custom', customType: 'rubato-context-note', display: false, content: 'x', timestamp: 0 };
/** One Pi run as the engine publishes it. */
const run = (input, ...tail) => [{ type: 'agent_start' }, { type: 'turn_start' },
  { type: 'message_start', message: input }, { type: 'message_end', message: input },
  ...tail.flatMap((message) => [{ type: 'message_start', message }, { type: 'message_end', message }]),
  { type: 'agent_end' }, { type: 'agent_settled' }];
const pass = (filter, events) => events.flatMap((event) => filter.accept(event));

test('a run the clock started passes nothing; any other run passes whole, in order', () => {
  for (const what of ['heartbeat', 'greeting', 'wake', 'recall', 'daily-report', 'sleep']) {
    assert.deepEqual(pass(createQuietRuns(), run(wake(what), answer)), [], what);
  }
  for (const input of [user, notice]) {
    const events = run(input, answer);
    assert.deepEqual(pass(createQuietRuns(), events), events);
  }
  const quietThenNot = [...run(wake('heartbeat'), answer), ...run(user, answer)];
  assert.deepEqual(pass(createQuietRuns(), quietThenNot), run(user, answer), 'the next run is judged on its own');
});

test("Pi's own hidden messages before the input wait with the start; a run with no input shows", () => {
  const events = [{ type: 'agent_start' }, { type: 'message_start', message: notesNudge }, { type: 'message_end', message: notesNudge },
    { type: 'message_start', message: wake('heartbeat') }, { type: 'message_end', message: answer }, { type: 'agent_settled' }];
  assert.deepEqual(pass(createQuietRuns(), events), []);
  const continued = [{ type: 'agent_start' }, { type: 'message_start', message: answer }, { type: 'agent_settled' }];
  assert.deepEqual(pass(createQuietRuns(), continued), continued);
});

test('an input that is not the clock joins a quiet run: it shows from there as a run of its own', () => {
  const filter = createQuietRuns();
  const shown = pass(filter, [{ type: 'agent_start' }, { type: 'message_start', message: wake('heartbeat') }, { type: 'message_end', message: answer },
    { type: 'message_start', message: notice }, { type: 'message_end', message: answer }, { type: 'agent_settled' }]);
  assert.deepEqual(shown.map((event) => [event.type, event.message?.details?.kind ?? event.message?.role ?? null]),
    [['agent_start', null], ['message_start', 'notice'], ['message_end', 'assistant'], ['agent_settled', null]]);
});

test('a run the client asked for is never held or hidden', () => {
  const filter = createQuietRuns({ owned: () => true });
  assert.deepEqual(filter.accept({ type: 'agent_start' }), [{ type: 'agent_start' }]);
  assert.deepEqual(filter.accept({ type: 'message_start', message: wake('heartbeat') }), [{ type: 'message_start', message: wake('heartbeat') }]);
});

test('idle() waits for a quiet run to settle', async () => {
  const filter = createQuietRuns();
  await filter.idle();
  filter.accept({ type: 'agent_start' });
  let done = false;
  const waiting = filter.idle().then(() => { done = true; });
  filter.accept({ type: 'message_start', message: wake('heartbeat') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  filter.accept({ type: 'agent_settled' });
  await waiting;
  assert.equal(done, true);
});

test('quietMessages marks each clock wake and its run up to the next other input', () => {
  const messages = [user, answer, wake('heartbeat'), { ...answer, timestamp: 5 }, wake('sleep'), { ...answer, timestamp: 6 }, notice, { ...answer, timestamp: 7 }];
  const quiet = quietMessages(messages);
  assert.deepEqual(messages.map((message) => quiet.has(message)), [false, false, true, true, true, true, false, false]);
});

test('on the stream: a heartbeat run reaches T3 as nothing, and a message sent meanwhile goes in after it', async () => {
  const commands = [];
  const client = { client: { connected: true }, attached: [], listener: null,
    async attach(id) { client.attached.push(id); }, async subscribeSession(listener) { client.listener = listener; return async () => {}; },
    async command(command) { commands.push(command); return command.type === 'prompt' ? { disposition: 'started' } : undefined; },
    async reply() {}, async close() {} };
  const records = [];
  const appended = [];
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(),
    appendSessionMessage: async (_threadId, item) => { appended.push(item); } },
  { threadId: 't1', cwd: '/w', onRecord: (record) => records.push(record), awaitTimings: { pollMs: 5, graceMs: 5 } });
  conn.client = client;
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  const events = run(wake('heartbeat'), answer);
  const half = events.slice(0, 4);
  client.listener({ runtimeId: 'r1', sequence: half.length, status: 'running', events: half.map((event, index) => ({ sequence: index + 1, event })) });
  await conn.inbound;
  const sending = conn.request({ type: 'prompt', message: 'are you there?' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(commands.some((command) => command.type === 'prompt'), false, 'the message waits for the clock run');
  client.listener({ runtimeId: 'r1', sequence: events.length, status: 'idle',
    events: events.map((event, index) => ({ sequence: index + 1, event })).slice(half.length) });
  await sending;
  await conn.inbound;
  assert.deepEqual(records.filter((record) => record.type !== 'response'), [], 'T3 saw nothing of the run');
  assert.deepEqual(appended, [], 'and no row for the wake');
  assert.ok(commands.some((command) => command.type === 'prompt' && command.message === 'are you there?'));
  const reply = run(user, answer);
  client.listener({ runtimeId: 'r1', sequence: events.length + reply.length, status: 'idle',
    events: reply.map((event, index) => ({ sequence: events.length + index + 1, event })) });
  await conn.inbound;
  assert.deepEqual(records.filter((record) => record.type !== 'response').map((record) => record.type), reply.map((event) => event.type),
    'the person\'s run arrives whole');
});

test("the quiet wakes are Rubato's clock; a wake meant for the person still opens a turn the app shows", () => {
  for (const what of QUIET_WAKES) assert.ok(WAKES.includes(what), what);
  assert.deepEqual([...QUIET_WAKES].sort(), ['daily-report', 'greeting', 'heartbeat', 'recall', 'sleep', 'wake']);
  const review = wake('persona-review');
  const events = run(review, answer);
  assert.deepEqual(pass(createQuietRuns(), events), events);
  assert.equal(sessionMessageFrom(review, 't1')?.context.records[0].payload.kind, 'wake', 'its row opens the turn, drawn as nothing');
  assert.equal(sessionMessageFrom(wake('heartbeat'), 't1'), undefined);
});

// ── Segno port: clock runs stay out on every path (verifier F1–F3) ──

const toolDeclaration = { role: 'system', content: [{ type: 'text', text: 'tools added' }], timestamp: 0 };
/** A run whose input comes after Pi's tool declaration, as a new conversation's first run does. */
const runAfterDeclaration = (input, ...tail) => [{ type: 'agent_start' }, { type: 'turn_start' },
  { type: 'message_start', message: toolDeclaration }, { type: 'message_end', message: toolDeclaration },
  ...run(input, ...tail).slice(2)];

test('a clock run that opens with Pi\'s tool declaration is still quiet', () => {
  for (const what of ['heartbeat', 'wake', 'recall', 'greeting']) {
    assert.deepEqual(pass(createQuietRuns(), runAfterDeclaration(wake(what), answer)), [], what);
  }
  const events = runAfterDeclaration(user, answer);
  assert.deepEqual(pass(createQuietRuns(), events), events, 'the person\'s run after a declaration passes whole');
});

test('a run opened by Pi\'s own message continues the stretch before it: quiet after a clock run, shown after the person\'s', () => {
  const background = { role: 'custom', customType: 'background-done', display: true, content: 'done', timestamp: 5 };
  const filter = createQuietRuns();
  assert.deepEqual(pass(filter, [...run(wake('heartbeat'), answer), ...run(background, answer)]), [], 'live agrees with history');
  assert.ok(quietMessages([wake('heartbeat'), answer, background, answer]).has(answer));
  const after = createQuietRuns();
  const shown = run(background, answer);
  pass(after, run(user, answer));
  assert.deepEqual(pass(after, shown), shown);
});

test('an attach replays the thread\'s missing answers but never a clock run\'s, nor opens a turn for one in flight', async () => {
  const { RubatoPiBridge } = await import('../src/bridge.mjs');
  const { EventProjection, importedId } = await import('../src/events.mjs');
  const clock = (what, at) => ({ ...wake(what), timestamp: at, details: { ...wake(what).details, messageId: `wake-${at}` } });
  const said = (text, at) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: at, stopReason: 'stop', provider: 'anthropic', model: 'claude-opus-5' });
  for (const streaming of [false, true]) {
    for (const what of ['heartbeat', 'greeting', 'wake', 'recall', 'sleep']) {
      const events = [];
      const projection = new EventProjection({ threadId: 'thread', sessionId: 'session', instanceId: 'instance', emit: (event) => events.push(event) });
      const bridge = Object.create(RubatoPiBridge.prototype);
      const visible = [{ role: 'user', content: 'hi', timestamp: 1 }, said('hello', 2)];
      bridge.projectedMessages = async () => visible.map((m) => ({ id: importedId('instance', 'session', m), text: typeof m.content === 'string' ? m.content : m.content[0].text, streaming: false }));
      bridge.rememberWindows([]); bridge.catalogue = async () => ({ models: [] });
      const tail = streaming ? [clock(what, 3)] : [clock(what, 3), said(`QUIET_${what}`, 4)];
      const snapshot = { runtimeId: 'rt', sequence: 1, pendingUi: [], state: { isStreaming: streaming, model: null, autoCompactionEnabled: true },
        messages: [...visible, ...tail, ...(streaming ? [] : [{ role: 'user', content: 'later', timestamp: 5 }, said('VISIBLE_later', 6)])] };
      const context = { session: { threadId: 'thread', status: 'connecting', resumeCursor: { kind: 'rubato-pi' } }, projection,
        client: { subscribeSession: async () => () => {}, snapshot: async () => snapshot } };
      await bridge.synchronize(context);
      assert.deepEqual(events.filter((e) => JSON.stringify(e).includes(`QUIET_${what}`)), [], `${what}: its answer stays out`);
      if (streaming) assert.equal(events.some((e) => e.type === 'turn.started'), false, `${what}: no turn opens for a clock run in flight`);
      else assert.ok(events.some((e) => JSON.stringify(e).includes('VISIBLE_later')), 'a visible answer the thread lacks still comes');
    }
  }
});

test('get_messages on the RPC stream (the adapter\'s backfill) leaves the clock runs out', async () => {
  const stored = [user, answer, wake('wake'), { ...answer, content: [{ type: 'text', text: 'QUIET' }], timestamp: 5 }, { ...user, timestamp: 6 }];
  const client = { client: { connected: true }, async attach() {}, async subscribeSession() { return async () => {}; },
    async command(command) { return command.type === 'get_messages' ? { messages: stored } : undefined; }, async reply() {}, async close() {} };
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(), appendSessionMessage: async () => {} },
    { threadId: 't1', cwd: '/w', onRecord: () => {}, awaitTimings: { pollMs: 5, graceMs: 5 } });
  conn.client = client;
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  const { messages } = await conn.request({ type: 'get_messages' });
  assert.deepEqual(messages, [user, answer, { ...user, timestamp: 6 }]);
});

test('get_messages and an attach both bring back what a quiet run sent the person, and nothing else of that run', async () => {
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'g1', name: 'telegram_send', arguments: { text: '좋은 아침~' } }], timestamp: 5, stopReason: 'toolUse' };
  const result = { role: 'toolResult', toolCallId: 'g1', toolName: 'telegram_send', content: [{ type: 'text', text: 'sent (id: 11)' }], timestamp: 6, isError: false };
  const stored = [user, answer, wake('greeting'), call, result, { ...answer, content: [{ type: 'text', text: 'PRIVATE' }], timestamp: 7 }];
  // The RPC path (the adapter's backfill).
  const written = [];
  const client = { client: { connected: true }, async attach() {}, async subscribeSession() { return async () => {}; },
    async command(command) { return command.type === 'get_messages' ? { messages: stored } : undefined; }, async reply() {}, async close() {} };
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(), appendSessionMessage: async (_t, item) => { written.push(item.text); } },
    { threadId: 't1', cwd: '/w', onRecord: () => {}, awaitTimings: { pollMs: 5, graceMs: 5 } });
  conn.client = client;
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  const { messages } = await conn.request({ type: 'get_messages' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(messages, [user, answer]);
  assert.deepEqual(written, ['좋은 아침~']);
  // The legacy attach path.
  const { RubatoPiBridge } = await import('../src/bridge.mjs');
  const { EventProjection } = await import('../src/events.mjs');
  const events = [];
  const appended = [];
  const projection = new EventProjection({ threadId: 'thread', sessionId: 'session', instanceId: 'instance', emit: (event) => events.push(event) });
  const bridge = Object.create(RubatoPiBridge.prototype);
  bridge.projectedMessages = async () => [];
  bridge.appendSessionMessage = async (_t, item) => { appended.push(item.text); };
  bridge.rememberWindows([]); bridge.catalogue = async () => ({ models: [] });
  const context = { session: { threadId: 'thread', status: 'connecting', resumeCursor: { kind: 'rubato-pi' } }, projection,
    client: { subscribeSession: async () => () => {}, snapshot: async () => ({ runtimeId: 'rt', sequence: 1, pendingUi: [],
      state: { isStreaming: false, model: null, autoCompactionEnabled: true }, messages: stored }) } };
  await bridge.synchronize(context);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(appended, ['좋은 아침~']);
  assert.equal(events.some((event) => JSON.stringify(event).includes('PRIVATE')), false);
});

test('attaching while a long run streams and its start already left the engine buffer: the stored tail decides', async () => {
  const say = (text, stopReason = 'stop', at = 2) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: at, stopReason });
  const midRun = [{ type: 'message_start', message: say('working', 'toolUse') },
    ...Array.from({ length: 300 }, (_, i) => ({ type: 'message_update', message: say('w'.repeat(i), 'toolUse') })),
    { type: 'message_end', message: say('working', 'toolUse') }, { type: 'turn_end' }];
  const rest = (mark) => [{ type: 'turn_start' }, { type: 'message_start', message: say(mark, 'stop', 3) }, { type: 'message_end', message: say(mark, 'stop', 3) },
    { type: 'turn_end' }, { type: 'agent_end' }, { type: 'agent_settled' }];
  async function attach(stored, mark) {
    const client = { client: { connected: true }, listener: null, async attach() {}, async subscribeSession(l) { client.listener = l; return async () => {}; },
      async command(c) { return c.type === 'get_messages' ? { messages: stored } : c.type === 'prompt' ? { disposition: 'started' } : undefined; },
      async reply() {}, async close() {} };
    const records = [];
    const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(), appendSessionMessage: async () => {} },
      { threadId: 't1', cwd: '/w', onRecord: (r) => records.push(r), awaitTimings: { pollMs: 5, graceMs: 5 } });
    conn.client = client;
    await conn.request({ type: 'switch_session', sessionPath: 's1' });
    let seq = 1000;
    const buffer = midRun.slice(-256);
    assert.equal(buffer.some((e) => e.type === 'agent_start'), false);
    client.listener({ runtimeId: 'r1', sequence: seq, status: 'running', events: buffer.map((event) => ({ sequence: ++seq - buffer.length, event })) });
    client.listener({ runtimeId: 'r1', sequence: seq + 6, status: 'idle', events: rest(mark).map((event) => ({ sequence: ++seq, event })) });
    for (let i = 0; i < 5; i += 1) { await conn.inbound; await new Promise((r) => setTimeout(r, 10)); }
    return records.filter((r) => r.type !== 'response' && JSON.stringify(r).includes(mark)).length;
  }
  assert.equal(await attach([user, answer, wake('sleep'), say('working', 'toolUse')], 'QUIET_TAIL'), 0, 'a clock run\'s tail stays out');
  assert.ok(await attach([user, answer, { ...user, timestamp: 6 }, say('working', 'toolUse')], 'SHOWN_TAIL') > 0, 'the person\'s run comes through');
});
