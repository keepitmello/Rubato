import test from 'node:test';
import assert from 'node:assert/strict';
import { EventProjection } from '../src/events.mjs';
import { t3Modules } from './t3-source.mjs';

const members = [
  { name: 'owner', task_id: 'st_owner', role: 'owner', task_summary: 'Implement mobile changes' },
  { name: 'verifier', task_id: 'st_verifier', role: 'verifier', task_summary: 'Verify mobile changes' },
];
function setup(args) {
  const events = [];
  const projection = new EventProjection({
    threadId: 'thread', sessionId: 'session', instanceId: 'instance', emit: event => events.push(event),
  });
  projection.project({ type: 'agent_start' });
  projection.project({ type: 'tool_execution_start', toolName: 'team_create', toolCallId: 'call_team', args });
  const finish = (details = { kind: 'created', team_name: 'mobile-team', team_run_id: 'run_team', members }) =>
    projection.project({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_team',
      isError: false, result: { details } });
  const tick = (task_id, status) => projection.project({
    type: 'extension_event', name: 'rubato.task.updated',
    data: { tasks: [{ task_id, status, live_progress: { current_tool: 'read' } }] },
  });
  return { events, projection, finish, tick };
}

for (const [name, args] of [
  ['named', { team_name: 'mobile-team' }],
  ['inline object', { inline_spec: { name: 'mobile-team', members: [] } }],
  ['inline JSON', { inline_spec: '{"name":"mobile-team","members":[]}' }],
  ['inline takes precedence', { team_name: 'ignored', inline_spec: { name: 'mobile-team', members: [] } }],
]) {
  test(`${name}: the team has a readable name and all member events carry its parent id`, () => {
    const { events, finish, tick } = setup(args);
    finish();
    const start = events.find(event => event.type === 'task.started');
    assert.equal(start.payload.title, 'mobile-team');
    assert.equal(start.payload.workflowName, 'mobile-team');
    tick('st_owner', 'running');
    tick('st_owner', 'completed');
    assert.equal(events.some(event => event.type === 'task.completed' && event.payload.taskId === 'call_team'), false);
    tick('st_verifier', 'completed');
    for (const event of events.filter(event => event.type.startsWith('task.') && event.payload.taskId.startsWith('st_'))) {
      assert.equal(event.payload.parentAgentId, 'call_team');
      assert.equal(event.payload.workflowName, 'mobile-team');
      assert.equal(event.payload.memberName, event.payload.taskId.slice(3));
    }
    assert.equal(events.filter(event => event.type === 'task.completed' && event.payload.taskId === 'call_team').length, 1);
  });
}

test('the team row starts at the create response with the server-derived name', () => {
  const { events, finish } = setup({ team_name: 'ignored', inline_spec: { members: [] } });
  assert.equal(events.some(event => event.type.startsWith('task.')), false);
  finish();
  const start = events.find(event => event.type === 'task.started' && event.payload.taskId === 'call_team');
  assert.equal(start.payload.title, 'mobile-team');
  assert.equal(start.payload.workflowName, 'mobile-team');
});

test('snapshots before the create response gain membership without reopening completed children', () => {
  const { events, finish, tick } = setup({ inline_spec: { members: [] } });
  tick('st_owner', 'completed');
  tick('st_verifier', 'completed');
  finish();
  for (const member of members) {
    const updates = events.filter(event => event.type === 'task.updated' && event.payload.taskId === member.task_id);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].payload.parentAgentId, 'call_team');
    assert.equal(updates[0].payload.status, undefined);
    assert.equal(events.filter(event => event.type === 'task.started' && event.payload.taskId === member.task_id).length, 1);
  }
  assert.equal(events.find(event => event.type === 'task.completed' && event.payload.taskId === 'call_team').payload.status, 'completed');
});

for (const kind of ['invalid_arguments', 'spec_error', 'runtime_error']) {
  test(`${kind}: a rejected team leaves no team row`, () => {
    const { events, finish } = setup({ inline_spec: '{invalid' });
    finish({ kind, reason: 'Team creation rejected' });
    assert.equal(events.some(event => event.type.startsWith('task.')), false);
    assert.equal(events.find(event => event.type === 'item.completed' && event.itemId === 'call_team').payload.title, 'Team');
  });
}

test('a member that ends its turn but stays resident is waiting, and wakes back up', () => {
  const { events, projection, finish } = setup({ inline_spec: { name: 'mobile-team', members: [] } });
  finish();
  const snapshot = (item) => projection.project({ type: 'extension_event', name: 'rubato.task.updated', data: { tasks: [item] } });
  const owner = (type) => events.filter(event => event.type === type && event.payload.taskId === 'st_owner');
  const rest = { task_id: 'st_owner', status: 'completed', residency_state: 'resident',
    final_response: 'Waiting on the build.\nDetails follow.' };
  snapshot(rest);
  snapshot(rest);
  assert.equal(owner('task.completed').length, 0);
  const waiting = owner('task.progress');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].payload.status, 'idle');
  assert.equal(waiting[0].payload.summary, 'Waiting on the build.');
  snapshot({ task_id: 'st_owner', status: 'running' });
  assert.equal(owner('task.progress').at(-1).payload.status, 'running');
  snapshot({ task_id: 'st_verifier', status: 'completed', residency_state: 'disposed' });
  snapshot({ task_id: 'st_owner', status: 'completed', residency_state: 'disposed', final_response: 'Done.' });
  assert.equal(owner('task.completed').length, 1);
  assert.equal(events.find(event => event.type === 'task.completed' && event.payload.taskId === 'call_team').payload.status, 'completed');
});

test('a direct agent that finishes resident still reads completed', () => {
  const { events, projection } = setup({ team_name: 'unused' });
  projection.project({ type: 'tool_execution_end', toolName: 'Agent', toolCallId: 'call_direct',
    result: { details: { agentId: 'st_direct', status: 'running', task_summary: 'Independent work' } } });
  projection.project({ type: 'extension_event', name: 'rubato.task.updated',
    data: { tasks: [{ task_id: 'st_direct', status: 'completed', residency_state: 'resident', final_response: 'Report.' }] } });
  assert.equal(events.find(event => event.type === 'task.completed' && event.payload.taskId === 'st_direct').payload.status, 'completed');
});

test('a schema-rejected team leaves no row, and the retry with the same name gets the board', () => {
  const { events, projection } = setup({ inline_spec: { name: 'mobile-team', members: [] } });
  projection.project({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_team', isError: true,
    result: { content: [{ type: 'text', text: 'Validation failed for tool "team_create"' }], details: {} } });
  projection.project({ type: 'tool_execution_start', toolName: 'team_create', toolCallId: 'call_retry',
    args: { inline_spec: { name: 'mobile-team', members: [] } } });
  projection.project({ type: 'extension_event', name: 'rubato.team.board.updated',
    data: { teams: [{ team_run_id: 'run_team', team_name: 'mobile-team', tasks: [] }] } });
  projection.project({ type: 'tool_execution_end', toolName: 'team_create', toolCallId: 'call_retry', isError: false,
    result: { details: { kind: 'created', team_name: 'mobile-team', team_run_id: 'run_team', members } } });
  const teamRows = new Set(events.filter(event => event.type.startsWith('task.') && event.payload.taskType === 'local_workflow')
    .map(event => event.payload.taskId));
  assert.deepEqual([...teamRows], ['call_retry']);
  assert.ok(events.some(event => event.type === 'task.progress' && event.payload.taskId === 'call_retry' && event.payload.board));
});

test('real T3 schema and panel fold group members, preserve direct spawns and count completion', {
  skip: !process.env.T3_SOURCE,
}, async () => {
  const modules = t3Modules(process.env.T3_SOURCE);
  const { ProviderRuntimeEvent } = await modules.source('packages/contracts/src/providerRuntime.ts');
  const Schema = await modules.effect('Schema');
  const { foldSubagentActivities, deriveAgentPanelModel } =
    await modules.source('packages/client-runtime/src/state/subagentRuntime.ts');
  const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
  for (const earlySnapshots of [false, true]) {
    const { events, projection, finish, tick } = setup({ inline_spec: { members: [] } });
    projection.project({ type: 'tool_execution_end', toolName: 'Agent', toolCallId: 'call_direct',
      result: { details: { agentId: 'st_direct', status: 'running', task_summary: 'Independent work' } } });
    if (earlySnapshots) tick('st_owner', 'completed');
    finish();
    const panel = () => deriveAgentPanelModel({
      agents: foldSubagentActivities(events.map(decode).filter(event => event.type.startsWith('task.'))
        .map(event => ({ ...event, kind: event.type })), { sessionLive: true }),
    });
    let model = panel();
    assert.equal(model.workflows.length, 1);
    assert.equal(model.workflows[0].workflow.workflowName, 'mobile-team');
    assert.deepEqual(model.workflows[0].unphasedMembers.map(member => member.id).sort(), ['st_owner', 'st_verifier']);
    assert.deepEqual(model.directAgents.map(agent => agent.id), ['st_direct']);
    if (!earlySnapshots) tick('st_owner', 'completed');
    model = panel();
    assert.equal(model.workflows[0].unphasedMembers.filter(member => member.status === 'completed').length, 1);
    assert.equal(model.workflows[0].workflow.status, 'running');
    tick('st_verifier', 'completed');
    model = panel();
    assert.equal(model.workflows[0].unphasedMembers.filter(member => member.status === 'completed').length, 2);
    assert.equal(model.workflows[0].workflow.status, 'completed');
  }
});
