import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStateFold, handleSessionStateRequest } from '../src/session-state.mjs';
import { RubatoPiBridge } from '../src/bridge.mjs';

const members = [
  { name: 'owner', task_id: 'st_owner', role: 'owner', task_summary: 'Implement mobile changes' },
  { name: 'verifier', task_id: 'st_verifier', role: 'verifier', task_summary: 'Verify mobile changes' },
];
const tick = (fold, task) => fold.feed({ type: 'extension_event', name: 'rubato.task.updated', data: { tasks: [task] } });

test('a team and its members fold into rows the Agents panel joins by team id and spawn call', () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  fold.feed({ type: 'agent_start' });
  fold.feed({ type: 'tool_execution_start', toolName: 'team_create', toolCallId: 'call_team', args: { team_name: 'mobile-team' } });
  fold.feed({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_team', isError: false,
    result: { details: { kind: 'created', team_name: 'mobile-team', team_run_id: 'run_team', members } } });
  tick(fold, { task_id: 'st_owner', status: 'running', live_progress: { current_tool: 'read' } });
  fold.feed({ type: 'extension_event', name: 'rubato.team.board.updated', data: { teams: [{ team_run_id: 'run_team', team_name: 'mobile-team',
    tasks: [{ id: '1', subject: 'Port', description: 'Port it', status: 'in_progress', owner: 'owner', blocked_by: [] }] }] } });
  const state = fold.snapshot();
  assert.equal(state.teams.length, 1);
  const [team] = state.teams;
  assert.equal(team.name, 'mobile-team');
  assert.equal(team.spawnToolCallId, 'call_team');
  assert.deepEqual(team.members.sort(), ['st_owner', 'st_verifier']);
  assert.equal(team.board.tasks[0].subject, 'Port');
  const owner = state.agents.find((agent) => agent.taskId === 'st_owner');
  assert.equal(owner.teamRunId, team.teamRunId);
  assert.equal(owner.parentAgentId, team.teamRunId);
  assert.equal(owner.memberName, 'owner');
  assert.equal(owner.status, 'running');
  assert.equal(owner.spawnToolCallId, 'call_team');
});

test('a resident member that ends its turn rests; the team follows its members to the end', () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  fold.feed({ type: 'agent_start' });
  fold.feed({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_team', isError: false,
    result: { details: { kind: 'created', team_name: 'mobile-team', team_run_id: 'run_team', members } } });
  tick(fold, { task_id: 'st_owner', status: 'completed', residency_state: 'resident', final_response: 'Done porting.' });
  // Not `waiting`: T3 reads that as work in progress, and the panel drew a resting member thinking.
  assert.equal(fold.snapshot().agents.find((agent) => agent.taskId === 'st_owner').status, 'idle');
  tick(fold, { task_id: 'st_owner', status: 'completed', final_response: 'Done porting.' });
  tick(fold, { task_id: 'st_verifier', status: 'failed', error: 'Build broke' });
  const state = fold.snapshot();
  assert.equal(state.agents.find((agent) => agent.taskId === 'st_owner').status, 'completed');
  assert.equal(state.teams[0].status, 'failed');
});

test('a team whose members all rest is idle, and a wake makes it and the member run again', () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  fold.feed({ type: 'agent_start' });
  fold.feed({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_team', isError: false,
    result: { details: { kind: 'created', team_name: 'mobile-team', team_run_id: 'run_team', members } } });
  const status = (id) => fold.snapshot().agents.find((agent) => agent.taskId === id).status;
  tick(fold, { task_id: 'st_owner', status: 'completed', residency_state: 'resident', final_response: 'Waiting on review.' });
  tick(fold, { task_id: 'st_verifier', status: 'completed', residency_state: 'resident', final_response: 'Nothing to check yet.' });
  assert.deepEqual([status('st_owner'), status('st_verifier'), fold.snapshot().teams[0].status], ['idle', 'idle', 'idle']);
  tick(fold, { task_id: 'st_owner', status: 'running', residency_state: 'resident' });
  assert.deepEqual([status('st_owner'), fold.snapshot().teams[0].status], ['running', 'running']);
});

// A resident child's record keeps its last tracked run; the engine's `member_turn` says what it
// did since (task-rpc-bridge member-turn-watch.ts).
const teamFold = () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  fold.feed({ type: 'agent_start' });
  fold.feed({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_team', isError: false,
    result: { details: { kind: 'created', team_name: 'mobile-team', team_run_id: 'run_team', members } } });
  return fold;
};
const agentRow = (fold, id) => fold.snapshot().agents.find((agent) => agent.taskId === id);
const firstRun = { task_id: 'st_verifier', status: 'completed', residency_state: 'resident', final_response: 'Baseline checks saved.\nMore.' };

test("a resting member's line follows its latest final message, not the record's first run", () => {
  const fold = teamFold();
  tick(fold, firstRun);
  assert.equal(agentRow(fold, 'st_verifier').activity, 'Baseline checks saved.');
  tick(fold, { ...firstRun, member_turn: { state: 'resting', final_response: 'Verified up to 0e4924c98.\nDetails below.' } });
  const row = agentRow(fold, 'st_verifier');
  assert.equal(row.status, 'idle');
  assert.equal(row.activity, 'Verified up to 0e4924c98.');
  assert.equal(row.result, undefined);
  assert.equal(row.awaiting, undefined);
});

test('a member whose own background work will wake it rests with that work named; nothing pending rests bare', () => {
  const fold = teamFold();
  tick(fold, { ...firstRun, member_turn: { state: 'resting', final_response: 'Suite started.',
    awaiting: [{ id: 'bash_9', description: 'bun test (pi-runtime)' }] } });
  assert.deepEqual(agentRow(fold, 'st_verifier').awaiting, [{ id: 'bash_9', description: 'bun test (pi-runtime)' }]);
  assert.equal(agentRow(fold, 'st_verifier').status, 'idle');
  tick(fold, { ...firstRun, member_turn: { state: 'resting', final_response: 'Suite passed.', awaiting: [] } });
  assert.equal(agentRow(fold, 'st_verifier').awaiting, undefined);
  assert.equal(agentRow(fold, 'st_verifier').activity, 'Suite passed.');
});

test('a member its inbox woke works, with its team, though its record still says completed', () => {
  const fold = teamFold();
  tick(fold, firstRun);
  tick(fold, { task_id: 'st_owner', status: 'completed', residency_state: 'resident', final_response: 'Ported.' });
  assert.equal(fold.snapshot().teams[0].status, 'idle');
  tick(fold, { ...firstRun, live_progress: { current_tool: 'bash npm test' },
    member_turn: { state: 'working', assignment: { from: 'lead', summary: 'Recheck feat/companion' } } });
  const row = agentRow(fold, 'st_verifier');
  assert.equal(row.status, 'running');
  assert.equal(row.activity, 'bash npm test');
  assert.deepEqual(row.assignment, { from: 'lead', summary: 'Recheck feat/companion' });
  assert.equal(fold.snapshot().teams[0].status, 'running');
});

test('an agent outside a team that ended its turn on its own background work waits, then ends with its latest answer', () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  const base = { task_id: 'st_solo', status: 'completed', residency_state: 'resident', final_response: 'Kicked off the build.' };
  tick(fold, { ...base, member_turn: { state: 'resting', final_response: 'Kicked off the build.',
    awaiting: [{ id: 'bash_2', description: 'npm run build' }] } });
  assert.equal(agentRow(fold, 'st_solo').status, 'idle');
  assert.deepEqual(agentRow(fold, 'st_solo').awaiting, [{ id: 'bash_2', description: 'npm run build' }]);
  tick(fold, { ...base, member_turn: { state: 'working' } });
  assert.equal(agentRow(fold, 'st_solo').status, 'running');
  tick(fold, { ...base, member_turn: { state: 'resting', final_response: 'Build passed.', awaiting: [] } });
  assert.equal(agentRow(fold, 'st_solo').status, 'completed');
  assert.equal(agentRow(fold, 'st_solo').result, 'Build passed.');
});

test('the session speed score comes from the engine and clears with null', () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  fold.feed({ type: 'extension_event', name: 'rubato.speed.updated', data: { speed: 87 } });
  assert.equal(fold.snapshot().speedIndex, 87);
  fold.feed({ type: 'extension_event', name: 'rubato.speed.updated', data: { speed: null } });
  assert.equal(fold.snapshot().speedIndex, null);
});

test('the route answers a thread it has never seen with an empty state', async () => {
  const response = await handleSessionStateRequest({ read: () => null }, new Request('http://x/rubato/session-state?threadId=t9'));
  assert.deepEqual(await response.json(), { speedIndex: null, agents: [], teams: [], cache: null });
  const bad = await handleSessionStateRequest({ read: () => null }, new Request('http://x/rubato/session-state'));
  assert.equal(bad.status, 400);
});

test('a thread bound to another session shows nothing of the previous one', () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's-before' });
  fold.feed({ type: 'extension_event', name: 'rubato.task.updated', data: { tasks: [{ task_id: 'st_a', status: 'running' }] } });
  fold.feed({ type: 'extension_event', name: 'rubato.speed.updated', data: { speed: 50 } });
  fold.rebind('s-after');
  assert.deepEqual(fold.snapshot().agents, []);
  assert.equal(fold.snapshot().speedIndex, null);
});

test('a GUI restart finds every agent row and the speed again, however long the session ran', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rubato-session-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const threadId = 'import:rubato:server:session-1';
  const before = new RubatoPiBridge({ descriptorPath: '/unused', instanceId: 'rubato', sessionStateDir: dir });
  const fold = before.stateFor(threadId, 's1');
  for (let index = 0; index < 400; index++) tick(fold, { task_id: `st_${index}`, status: 'completed', final_response: `result ${index}` });
  fold.feed({ type: 'extension_event', name: 'rubato.speed.updated', data: { speed: 61 } });
  await before.close();

  const after = new RubatoPiBridge({ descriptorPath: '/unused', instanceId: 'rubato', sessionStateDir: dir });
  t.after(() => after.close());
  const shown = after.sessionState(threadId);
  assert.equal(shown.agents.length, 400);
  assert.equal(shown.agents[0].result, 'result 0');
  assert.equal(shown.speedIndex, 61);
  // The same session reattached keeps them; another session shows nothing of them.
  assert.equal(after.stateFor(threadId, 's1').snapshot().agents.length, 400);
  after.stateFor(threadId, 's2');
  assert.deepEqual(after.sessionState(threadId).agents, []);
  await after.flushStates();
  const third = new RubatoPiBridge({ descriptorPath: '/unused', instanceId: 'rubato', sessionStateDir: dir });
  t.after(() => third.close());
  assert.deepEqual(third.sessionState(threadId).agents, []);
});

const defer = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
test("a graceful GUI close waits for an already-started debounced session-state write", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "state-close-"));
  const started = defer();
  const release = defer();
  const bridge = new RubatoPiBridge({ sessionStateDir: dir });
  const originalWrite = bridge.writeState.bind(bridge);
  const writes = [];
  // Delay the disk boundary, without changing save scheduling or close/flush behavior.
  bridge.writeState = (...args) => {
    const write = (async () => { started.resolve(); await release.promise; await originalWrite(...args); })();
    writes.push(write);
    return write;
  };
  let closing;
  try {
    bridge.stateFor("new-v2-thread", "native-session").feed({
      type: "extension_event", name: "rubato.speed.updated", data: { speed: 61 },
    });
    await started.promise;
    let returned = false;
    closing = bridge.close().then(() => { returned = true; });
    await nextTurn();
    assert.equal(returned, false, "close returned while the last state write was still blocked");
  } finally {
    release.resolve();
    await closing;
    await Promise.all(writes);
    await rm(dir, { recursive: true, force: true });
  }
});
