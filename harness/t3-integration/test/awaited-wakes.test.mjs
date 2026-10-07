import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { AWAIT_TITLE, EventProjection } from '../src/events.mjs';
import { t3Modules } from './t3-source.mjs';

let decodeEvent = (value) => value;
if (process.env.T3_SOURCE) {
  const { ProviderRuntimeEvent } = await import(`${process.env.T3_SOURCE}/packages/contracts/src/providerRuntime.ts`);
  const Schema = await t3Modules(process.env.T3_SOURCE).effect('Schema');
  decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
}
const until = async (predicate) => { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); } throw new Error('Condition did not settle'); };
const timings = { pollMs: 10, graceMs: 40 };

/** A projection whose Pi answers `waits` (mutable) when asked what the idle agent waits on. */
function harness(waits = { items: [] }) {
  const events = [];
  const released = [];
  const answer = { current: waits };
  const projection = new EventProjection({ threadId: 'thread', sessionId: 'session', instanceId: 'instance',
    emit: (event) => events.push(decodeEvent(event)), awaitTimings: timings, released: () => released.push(true),
    awaitedWakes: async () => { if (answer.current instanceof Error) throw answer.current; return answer.current; } });
  const of = (type) => events.filter((event) => event.type === type);
  const waitRows = () => events.filter((event) => event.payload?.title === AWAIT_TITLE);
  return { projection, events, released, answer, of, waitRows };
}

test('a settle on a wait that will wake the agent keeps the turn open and names the wait', async () => {
  const { projection, answer, of, waitRows, released } = harness({ items: [
    { id: 'mon_1', description: 'wait for unittest run' }, { id: 'bash_16', description: 'python3 -m unittest' }] });
  projection.project({ type: 'agent_start' });
  const turnId = projection.turnId;
  projection.project({ type: 'agent_settled' });
  await until(() => waitRows().length === 2);
  assert.equal(of('turn.completed').length, 0, 'no "Thread completed" while the wake is still coming');
  assert.equal(projection.turnId, turnId);
  const [row] = waitRows();
  assert.equal(row.type, 'item.started');
  assert.equal(row.turnId, turnId);
  assert.equal(row.payload.status, 'inProgress');
  assert.equal(row.payload.detail, 'wait for unittest run · python3 -m unittest');
  // T3 draws no row from a start, so the update right after it is what shows the wait.
  assert.equal(waitRows()[1].type, 'item.updated');
  assert.deepEqual(waitRows()[1].payload.data.rubatoActivity,
    { kind: 'wait', target: 'wait for unittest run · python3 -m unittest' });

  // The tests finish: the monitor has reported, the command has exited, the completion wakes the agent.
  answer.current = { items: [] };
  projection.project({ type: 'agent_start' });
  assert.equal(projection.turnId, turnId, 'the wake continues the turn that waited');
  assert.equal(of('turn.started').length, 1);
  assert.deepEqual(waitRows().map((event) => [event.type, event.payload.status]),
    [['item.started', 'inProgress'], ['item.updated', 'inProgress'], ['item.completed', 'completed']]);

  projection.project({ type: 'agent_settled' });
  await until(() => of('turn.completed').length === 1);
  assert.equal(of('turn.completed')[0].payload.state, 'completed');
  assert.equal(of('turn.completed')[0].turnId, turnId);
  assert.equal(projection.turnId, undefined);
  assert.equal(released.length, 1, 'the bridge hears the turn it did not close itself');
});

test('a settle with nothing to wait on ends the turn without a wait row', async () => {
  const { projection, of, waitRows } = harness({ items: [] });
  projection.project({ type: 'agent_start' });
  projection.project({ type: 'agent_settled' });
  await until(() => of('turn.completed').length === 1);
  assert.equal(waitRows().length, 0);
});

test('a runtime that cannot say what it waits on ends the turn as before', async () => {
  const { projection, of } = harness(new Error('Unknown extension RPC request: rubato.terminal.awaited-wakes'));
  projection.project({ type: 'agent_start' });
  projection.project({ type: 'agent_settled' });
  await until(() => of('turn.completed').length === 1);
  assert.equal(of('turn.completed')[0].payload.state, 'completed');
});

test('a projection the bridge gave no question ends the turn on the settle itself', () => {
  const events = [];
  const projection = new EventProjection({ threadId: 't', sessionId: 's', instanceId: 'i', emit: (event) => events.push(event) });
  projection.project({ type: 'agent_start' });
  projection.project({ type: 'agent_settled' });
  assert.deepEqual(events.map((event) => event.type), ['turn.started', 'turn.completed']);
});

test('a wait that ends with no wake closes the turn after the grace, not before', async () => {
  const { projection, answer, of, waitRows } = harness({ items: [{ id: 'bash_3', description: 'npm test' }] });
  projection.project({ type: 'agent_start' });
  projection.project({ type: 'agent_settled' });
  await until(() => waitRows().length === 2);
  answer.current = { items: [] };
  await delay(timings.pollMs * 3);
  assert.equal(of('turn.completed').length, 0, 'the wake gets its moment to start');
  await until(() => of('turn.completed').length === 1);
  assert.deepEqual(waitRows().map((event) => event.type), ['item.started', 'item.updated', 'item.completed']);
  assert.equal(of('turn.completed')[0].payload.state, 'completed');
});

test('the wait row follows what is still awaited', async () => {
  const { projection, answer, waitRows } = harness({ items: [{ id: 'a', description: 'build' }, { id: 'b', description: 'lint' }] });
  projection.project({ type: 'agent_start' });
  projection.project({ type: 'agent_settled' });
  await until(() => waitRows().length === 2);
  answer.current = { items: [{ id: 'a', description: 'build' }] };
  await until(() => waitRows().length === 3);
  assert.equal(waitRows()[2].type, 'item.updated');
  assert.equal(waitRows()[2].payload.detail, 'build');
  await delay(timings.pollMs * 3);
  assert.equal(waitRows().length, 3, 'an unchanged wait sends nothing new');
  projection.settle();
});

test('an interrupted or failed run is not held open', async () => {
  for (const mark of ['interrupted', 'failed']) {
    const { projection, of, waitRows } = harness({ items: [{ id: 'bash_1', description: 'sleep 60' }] });
    projection.project({ type: 'agent_start' });
    projection[mark] = true;
    projection.project({ type: 'agent_settled' });
    assert.equal(of('turn.completed').length, 1, mark);
    await delay(timings.pollMs * 2);
    assert.equal(waitRows().length, 0, mark);
  }
});

/** A bridge around one held turn; Pi idles until a prompt starts a run. */
function bridgeHarness(threadId) {
  const { projection, events, of, waitRows } = harness({ items: [{ id: 'bash_9', description: 'cargo build' }] });
  const bridge = Object.create(RubatoPiBridge.prototype);
  bridge.skillNames = new Set();
  const commands = [];
  const state = { isStreaming: true, isCompacting: false, pendingMessageCount: 0, requestTimeline: { pendingInputs: [] } };
  const context = { sessionId: 'session', projection, session: { threadId, status: 'running' }, queue: Promise.resolve(), stopped: false,
    client: { command: async (command) => {
      commands.push(command);
      if (command.type === 'get_state') return state;
      if (command.type === 'prompt') state.isStreaming = true;
    } } };
  bridge.sessions = new Map([[threadId, context]]);
  projection.project({ type: 'agent_start' });
  return { bridge, context, projection, commands, state, events, of, waitRows };
}

test('a message sent while the turn waits starts a run in that turn instead of a steer to an idle Pi', async () => {
  const { bridge, projection, commands, state, of, waitRows } = bridgeHarness('send-thread');
  const turnId = projection.turnId;
  state.isStreaming = false;
  projection.project({ type: 'agent_settled' });
  await until(() => waitRows().length === 2);
  const sent = await bridge.sendTurn({ threadId: 'send-thread', input: 'while you wait, check the docs' });
  assert.equal(sent.turnId, turnId);
  assert.deepEqual(commands.filter((command) => ['prompt', 'steer'].includes(command.type)).map((command) => command.type), ['prompt']);
  assert.equal(of('turn.completed').length, 0);
  assert.equal(waitRows().at(-1).type, 'item.completed');
  assert.equal(projection.awaiting, undefined);
});

test('stop during a wait ends the turn as interrupted and closes the wait row', async () => {
  const { bridge, context, projection, state, of, waitRows } = bridgeHarness('stop-thread');
  state.isStreaming = false;
  projection.project({ type: 'agent_settled' });
  await until(() => waitRows().length === 2);
  await bridge.interruptTurn('stop-thread');
  assert.deepEqual(of('turn.completed').map((event) => event.payload.state), ['interrupted']);
  assert.equal(waitRows().at(-1).type, 'item.completed');
  assert.equal(context.session.status, 'ready');
  await delay(timings.graceMs * 2);
  assert.equal(of('turn.completed').length, 1, 'the stopped wait does not close the turn a second time');
});

test('a detached presentation forgets the wait without closing the turn behind T3', async () => {
  const { bridge, projection, state, of, waitRows } = bridgeHarness('detach-thread');
  bridge.openings = new Map(); bridge.claimed = new Set();
  bridge.sessions.get('detach-thread').client.close = async () => {};
  state.isStreaming = false;
  projection.project({ type: 'agent_settled' });
  await until(() => waitRows().length === 2);
  await bridge.stopSession('detach-thread');
  await delay(timings.graceMs * 2);
  assert.equal(of('turn.completed').length, 0);
  assert.equal(projection.awaiting, undefined);
});

test('a wait named only by a session id reads as background work, not the id', async () => {
  const { projection, waitRows } = harness({ items: [{ id: 'bash_16', description: 'bash_16' }] });
  projection.project({ type: 'agent_start' });
  projection.project({ type: 'agent_settled' });
  await until(() => waitRows().length === 2);
  assert.deepEqual(waitRows()[1].payload.data.rubatoActivity, { kind: 'wait' });
  projection.settle();
  assert.deepEqual(waitRows().at(-1).payload.data.rubatoActivity, { kind: 'wait' });
});
