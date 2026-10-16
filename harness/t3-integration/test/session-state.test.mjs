import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateFold, handleSessionStateRequest } from '../src/session-state.mjs';

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

test('a resident member that ends its turn waits; the team follows its members to the end', () => {
  const fold = new SessionStateFold({ threadId: 't1', sessionId: 's1' });
  fold.feed({ type: 'agent_start' });
  fold.feed({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_team', isError: false,
    result: { details: { kind: 'created', team_name: 'mobile-team', team_run_id: 'run_team', members } } });
  tick(fold, { task_id: 'st_owner', status: 'completed', residency_state: 'resident', final_response: 'Done porting.' });
  assert.equal(fold.snapshot().agents.find((agent) => agent.taskId === 'st_owner').status, 'waiting');
  tick(fold, { task_id: 'st_owner', status: 'completed', final_response: 'Done porting.' });
  tick(fold, { task_id: 'st_verifier', status: 'failed', error: 'Build broke' });
  const state = fold.snapshot();
  assert.equal(state.agents.find((agent) => agent.taskId === 'st_owner').status, 'completed');
  assert.equal(state.teams[0].status, 'failed');
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
