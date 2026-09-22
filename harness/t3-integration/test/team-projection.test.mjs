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
    const start = events.find(event => event.type === 'task.started');
    assert.equal(start.payload.title, 'mobile-team');
    assert.equal(start.payload.workflowName, 'mobile-team');
    finish();
    tick('st_owner', 'running');
    tick('st_owner', 'completed');
    assert.equal(events.some(event => event.type === 'task.completed' && event.payload.taskId === 'call_team'), false);
    tick('st_verifier', 'completed');
    for (const event of events.filter(event => event.type.startsWith('task.') && event.payload.taskId.startsWith('st_'))) {
      assert.equal(event.payload.parentAgentId, 'call_team');
      assert.equal(event.payload.workflowName, 'mobile-team');
    }
    assert.equal(events.filter(event => event.type === 'task.completed' && event.payload.taskId === 'call_team').length, 1);
  });
}

test('a server-derived team name replaces the placeholder through a persisted metadata update', () => {
  const { events, finish } = setup({ team_name: 'ignored', inline_spec: { members: [] } });
  assert.equal(events.find(event => event.type === 'task.started').payload.title, 'Team');
  finish();
  const update = events.find(event => event.type === 'task.updated' && event.payload.taskId === 'call_team');
  assert.equal(update.payload.title, 'mobile-team');
  assert.equal(update.payload.workflowName, 'mobile-team');
  assert.equal(update.payload.status, undefined);
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
  test(`${kind}: a rejected team does not remain Working`, () => {
    const { events, finish } = setup({ inline_spec: '{invalid' });
    finish({ kind, reason: 'Team creation rejected' });
    const done = events.find(event => event.type === 'task.completed');
    assert.equal(done.payload.status, 'failed');
    assert.equal(done.payload.summary, 'Team creation rejected');
  });
}

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
