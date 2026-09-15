import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { SessionClient } from '../../pi-server/src/client.mjs';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { userStartedSession } from '../src/bridge.mjs';
import { EventProjection } from '../src/events.mjs';
import {t3Modules} from './t3-source.mjs';
const fixture = fileURLToPath(new URL('../../pi-server/test/fixtures/rpc.mjs', import.meta.url));
const until = async (predicate) => { for (let i=0;i<500;i++) { if (await predicate()) return; await delay(10); } throw new Error('Condition did not settle'); };
let decodeEvent = (value) => value;
if (process.env.T3_SOURCE) {
  const { ProviderRuntimeEvent } = await import(`${process.env.T3_SOURCE}/packages/contracts/src/providerRuntime.ts`);
  const Schema = await t3Modules(process.env.T3_SOURCE).effect('Schema');
  decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
}
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-t3-'));
  const service = await serveProfile({ agentDir: root, idleMs: 60, workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: fixture }) });
  const events = [];
  const bridge = new RubatoPiBridge({ descriptorPath: service.descriptorPath, instanceId: 'rubato-test',
    // 이 파일의 시험은 전송·부착 의미를 본다. 시험 세션은 임시 폴더에서 도니
    // 기본 정책이면 목록에서 빠진다. 정책 자체는 아래 별도 시험에서 본다.
    shows: () => true, emit: (event) => events.push(decodeEvent(event)) });
  const external = await new SessionClient(service.descriptor).connect();
  t.after(async () => { await bridge.close(); await external.close(); await service.close(); await rm(root, { force:true, recursive:true }); });
  return { root, service, events, bridge, external };
}
test('T3 discovers stored/live sessions and attaches without a duplicate worker; stopping T3 only detaches', async (t) => {
  const { root, service, events, bridge, external } = await setup(t);
  const created = await external.create({ cwd: root, title: 'Existing' });
  assert.equal((await bridge.inventory()).length, 1);
  assert.equal(service.host.metrics.runtimeStarts, 0);
  await external.attach(created.sessionId);
  await external.command({ type:'prompt', message:'background' });
  const before = await external.snapshot();
  const input = { threadId:'t3-thread', runtimeMode:'full-access', cwd:root, resumeCursor:bridge.cursor(created.sessionId) };
  const [one, two] = await Promise.all([bridge.startSession(input), bridge.startSession(input)]);
  assert.deepEqual(one, two);
  assert.equal(service.host.metrics.runtimeStarts, 1);
  assert.equal(bridge.sessions.get(input.threadId).runtimeId, before.runtimeId);
  assert.ok(events.some((event) => event.type==='session.state.changed' && event.payload.state==='running'));
  await bridge.stopSession(input.threadId);
  assert.equal((await external.snapshot()).state.isStreaming, true);
  await bridge.startSession(input);
  assert.equal(bridge.sessions.get(input.threadId).runtimeId, before.runtimeId);
  await bridge.interruptTurn(input.threadId);
  assert.equal((await external.snapshot()).state.isStreaming, false);
});
test('T3 creates a new Pi session, forwards questions, reconnects and continues the same worker', async (t) => {
  const { root, service, events, bridge } = await setup(t);
  const session = await bridge.startSession({ threadId:'new-thread', runtimeMode:'full-access', cwd:root });
  const turn = await bridge.sendTurn({ threadId:'new-thread', input:'question' });
  assert.ok(turn.turnId);
  await until(() => events.some((event) => event.type==='user-input.requested'));
  const context = bridge.sessions.get('new-thread'); const runtimeId=context.runtimeId; const presentationClient=context.client;
  context.client.client.disconnect();
  const firstRecovery = bridge.recover();
  const secondRecovery = bridge.recover();
  assert.equal(firstRecovery, secondRecovery);
  await Promise.all([firstRecovery, secondRecovery]);
  assert.equal(context.client, presentationClient);
  assert.equal(context.runtimeId, runtimeId);
  assert.equal(service.host.metrics.runtimeStarts, 1);
  await bridge.respondToUserInput('new-thread','question-1',{'question-1':'yes'});
  await until(() => events.some((event) => event.type==='turn.completed'));
  assert.equal((await bridge.inventory())[0].sessionId, session.resumeCursor.sessionId);
});
test('a dead socket on an inventory request reconnects inside the bridge instead of failing the caller', async (t) => {
  const { root, bridge, external } = await setup(t);
  await external.create({ cwd: root, title: 'Kept' });
  const stale = await bridge.connection();
  let failures = 0;
  stale.list = () => { failures += 1; return Promise.reject(new Error('Byte transport closed')); };
  assert.equal((await bridge.inventory()).length, 1);
  // 두 번째 요청은 이미 새 연결을 쓴다. 죽은 클라이언트는 한 번만 맞고 버려진다.
  assert.deepEqual((await bridge.catalogue(root)).models, []);
  assert.equal(failures, 1);
  assert.notEqual(bridge.inventoryClient, stale);
});
test('a failure the socket did not cause still reaches the caller', async (t) => {
  const { bridge } = await setup(t);
  const client = await bridge.connection();
  let calls = 0;
  client.list = () => { calls += 1; return Promise.reject(new Error('Session directory is unreadable')); };
  await assert.rejects(bridge.inventory(), /unreadable/);
  assert.equal(calls, 1);
});
test('normalizer emits valid text, reasoning, tool, confirmation and settled events', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  const message={role:'assistant',timestamp:123,model:'fixture',content:[{type:'text',text:'hello'},{type:'thinking',thinking:'reason'}]};
  p.project({type:'agent_start'}); p.project({type:'message_update',message});
  p.project({type:'tool_execution_start',toolName:'bash',toolCallId:'tool1',args:{command:'pwd'}});
  p.project({type:'tool_execution_update',toolName:'bash',toolCallId:'tool1',partialResult:{content:[{type:'text',text:'/tmp'}]}});
  p.project({type:'tool_execution_end',toolName:'bash',toolCallId:'tool1',result:{content:[{type:'text',text:'/tmp'}]},isError:false});
  p.project({type:'extension_ui_request',method:'confirm',id:'approve',title:'Run command?'});
  p.project({type:'message_end',message:{...message,stopReason:'stop'}}); p.project({type:'agent_settled'});
  assert.ok(events.some(e=>e.type==='content.delta'&&e.payload.streamKind==='reasoning_text'));
  assert.ok(events.some(e=>e.type==='request.opened'));
  assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
  assert.equal(events.filter(e=>e.type==='content.delta'&&e.payload.streamKind==='assistant_text').map(e=>e.payload.delta).join(''),'hello');
});
test('a subagent spawn is a collab agent item with the mobile task lifecycle', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'agent_start'});
  p.project({type:'tool_execution_start', toolName:'Agent', toolCallId:'spawn-1', args:{prompt:'Inspect the auth path', summary:'Audit auth'}});
  p.project({type:'tool_execution_update', toolName:'Agent', toolCallId:'spawn-1', partialResult:{
    progress:{activity:'Audit auth · running read src/foo.ts', startedAt:1000}, childId:'st_1',
    currentTool:'read src/foo.ts', lastAssistantLine:'looking at middleware', turns:1, toolCalls:1,
  }});
  p.project({type:'tool_execution_end', toolName:'Agent', toolCallId:'spawn-1', isError:false,
    result:{content:[{type:'text', text:'Started'}], details:{agentId:'st_1', status:'running', task_summary:'Audit auth', name:'task-1', subagent_type:'quick'}}});
  const startedItem = events.find((event) => event.type==='item.started' && event.payload.itemType==='collab_agent_tool_call');
  assert.ok(startedItem, 'spawn was not classified as collab_agent_tool_call');
  assert.equal(startedItem.payload.title, 'Subagent task');
  assert.equal(startedItem.payload.detail, 'Audit auth');
  const started = events.find((event) => event.type==='task.started');
  assert.equal(typeof started?.payload.taskId, 'string');
  assert.equal(started.payload.agentKind, 'agent');
  assert.equal(started.payload.taskType, 'subagent');
  assert.equal(started.payload.description, 'Audit auth');
  assert.equal(started.payload.toolUseId, 'spawn-1');
  const progress = events.find((event) => event.type==='task.progress' && event.payload.lastToolName);
  assert.ok(progress, 'mobile spawn batch has no task.progress tick');
  assert.equal(progress.payload.agentKind, 'agent');
  assert.equal(progress.payload.taskId, started.payload.taskId);
  assert.equal(progress.payload.lastToolName, 'read src/foo.ts');
  assert.equal(events.filter((event) => event.type==='task.completed').length, 0, 'async spawn must not complete the task at ack');
  p.project({type:'tool_execution_start', toolName:'AgentOutput', toolCallId:'peek-1', args:{agentId:'st_1'}});
  p.project({type:'tool_execution_start', toolName:'AgentSend', toolCallId:'steer-1', args:{agentId:'st_1', message:'continue'}});
  p.project({type:'tool_execution_start', toolName:'team_task_list', toolCallId:'board-1', args:{}});
  const peek = events.filter((event) => event.itemId==='pi-tool:session:peek-1' || event.itemId==='pi-tool:session:steer-1' || event.itemId==='pi-tool:session:board-1');
  assert.equal(peek.every((event) => event.payload.itemType==='dynamic_tool_call'), true);
  assert.equal(events.filter((event) => event.type==='task.started').length, 1);
  p.project({type:'tool_execution_start', toolName:'team_create', toolCallId:'team-1', args:{team_name:'release-crew'}});
  p.project({type:'tool_execution_end', toolName:'team_create', toolCallId:'team-1', isError:false,
    result:{details:{kind:'created', team_run_id:'run-1', team_name:'release-crew', members:[{name:'alpha', status:'running', role:'implementer', task_id:'st_alpha', task_summary:'Ship the patch'}]}}});
  assert.ok(events.some((event) => event.type==='item.started' && event.payload.itemType==='collab_agent_tool_call' && event.payload.title==='Team'));
  const member = events.find((event) => event.type==='task.started' && event.payload.taskId==='st_alpha');
  assert.equal(member?.payload.agentKind, 'agent');
  assert.equal(member.payload.description, 'Ship the patch');
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_1', task_summary:'Audit auth', status:'running',
    live_progress:{ activity:'Audit auth · running grep TODO', started_at:2000, current_tool:'grep TODO',
      last_assistant_line:'found three', turns:2, tool_calls:3 },
  }]}});
  const live = events.filter((event) => event.type==='task.progress' && event.payload.lastToolName==='grep TODO');
  assert.equal(live.length, 1);
  assert.equal(live[0].payload.taskId, started.payload.taskId, 'live tick must keep the spawn taskId, not the child id');
  assert.equal(live[0].payload.description, 'Audit auth · running grep TODO');
  assert.equal(live[0].payload.agentKind, 'agent');
  p.project({type:'tool_execution_end', toolName:'AgentCancel', toolCallId:'cancel-1', args:{agentId:'st_1'}, result:{details:{agentId:'st_1', status:'cancelled'}}});
  assert.ok(events.some((event) => event.type==='task.completed' && event.payload.taskId===started.payload.taskId && event.payload.status==='stopped'));
});

test('a team member tick updates that member only, and one finish does not complete the team', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'agent_start'});
  p.project({type:'tool_execution_start', toolName:'team_create', toolCallId:'team-1', args:{team_name:'release-crew'}});
  p.project({type:'tool_execution_end', toolName:'team_create', toolCallId:'team-1', isError:false,
    result:{details:{kind:'created', team_run_id:'run-1', team_name:'release-crew', members:[
      {name:'alpha', status:'running', role:'implementer', task_id:'st_alpha', task_summary:'Ship the patch'},
      {name:'beta', status:'running', role:'reviewer', task_id:'st_beta', task_summary:'Review the patch'},
    ]}}});
  const teamId = events.find((event) => event.type==='task.started' && event.payload.taskType==='local_workflow').payload.taskId;
  const alphaStart = events.find((event) => event.type==='task.started' && event.payload.taskId==='st_alpha');
  const betaStart = events.find((event) => event.type==='task.started' && event.payload.taskId==='st_beta');
  assert.ok(alphaStart && betaStart && teamId);
  const before = events.length;
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_alpha', task_summary:'Ship the patch', status:'running',
    live_progress:{ activity:'Ship the patch · running bash git status', started_at:2000, current_tool:'bash git status', turns:1 },
  }]}});
  const ticks = events.slice(before).filter((event) => event.type==='task.progress');
  assert.deepEqual(ticks.map((event) => event.payload.taskId), ['st_alpha']);
  assert.equal(ticks[0].payload.description, 'Ship the patch · running bash git status');
  assert.equal(events.slice(before).some((event) => event.type==='task.progress' && event.payload.taskId==='st_beta'), false);
  assert.equal(events.slice(before).some((event) => event.payload.taskId===teamId && event.type==='task.completed'), false);
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_alpha', task_summary:'Ship the patch', status:'completed', final_response:'done',
  }]}});
  assert.ok(events.some((event) => event.type==='task.completed' && event.payload.taskId==='st_alpha'));
  assert.equal(events.some((event) => event.type==='task.completed' && event.payload.taskId===teamId), false, 'one member finishing must not complete the team');
  assert.equal(events.some((event) => event.type==='task.completed' && event.payload.taskId==='st_beta'), false);
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_beta', task_summary:'Review the patch', status:'completed',
  }]}});
  assert.ok(events.some((event) => event.type==='task.completed' && event.payload.taskId==='st_beta'));
  const teamDone = events.filter((event) => event.type==='task.completed' && event.payload.taskId===teamId);
  assert.equal(teamDone.length, 1);
  assert.equal(teamDone[0].payload.status, 'completed');
});

test('reconnect does not append a full answer over text already projected or still in flight', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  const message={role:'assistant',timestamp:12,content:[{type:'text',text:'abc'}]};
  p.message(message,false); const itemId=events[0].itemId;
  p.seed([{id:`assistant:${itemId}`,text:'a',streaming:true}]);
  p.message({...message,content:[{type:'text',text:'abcdef'}]},true);
  assert.deepEqual(events.filter(e=>e.type==='content.delta').map(e=>e.payload.delta),['abc','def']);
});

test('the app is offered work a person opened, not a scratch run', () => {
  assert.equal(userStartedSession({ sessionId:'a', cwd:'/private/tmp/bench', runtimeId:'r', status:'running' }), true);
  assert.equal(userStartedSession({ sessionId:'b', cwd:'/private/tmp/bench', runtimeId:null, status:'stored' }), false);
  assert.equal(userStartedSession({ sessionId:'c', cwd:path.join(tmpdir(), 'gone-' + Date.now()), status:'stored' }), false);
  assert.equal(userStartedSession({ sessionId:'d', cwd:'/Users/nobody/deleted-project', status:'stored' }), false);
  assert.equal(userStartedSession({ sessionId:'e', cwd:process.cwd(), status:'stored' }), true);
  assert.equal(userStartedSession({ sessionId:'f', cwd:'relative/path', status:'stored' }), false);
});

test('a scratch session never reaches the app, and the app keeps what it made itself', async (t) => {
  const { root, service, bridge } = await setup(t);
  const policy = new RubatoPiBridge({ descriptorPath: service.descriptorPath, instanceId: 'rubato-policy' });
  const external = await new SessionClient(service.descriptor).connect();
  t.after(async () => { await policy.close(); await external.close(); });
  const scratch = await external.create({ cwd: root, title: 'Bench run' });
  const real = await external.create({ cwd: process.cwd(), title: 'Real work' });
  const offered = await policy.inventory();
  assert.equal(offered.some((entry) => entry.sessionId === scratch.sessionId), false, '임시 폴더 세션이 앱으로 넘어갔다');
  assert.equal(offered.some((entry) => entry.sessionId === real.sessionId), true, '진짜 작업 폴더 세션이 빠졌다');
  // 앱이 직접 만든 세션은 임시 폴더에서 돌아도 앱의 것이다.
  const own = await policy.startSession({ threadId:'policy-thread', runtimeMode:'full-access', cwd:root });
  assert.equal((await policy.inventory()).some((entry) => entry.sessionId === own.resumeCursor.sessionId), true,
    '앱이 만든 세션이 정책에 걸려 사라졌다');
  assert.ok((await bridge.inventory()).length >= 2, '정책은 이 다리에만 걸린다');
});

const userContent = (message) => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');

test('a live child tick on rubato.task.updated reaches T3 as task.progress', async (t) => {
  const { root, events, bridge } = await setup(t);
  await bridge.startSession({ threadId:'tick-thread', runtimeMode:'full-access', cwd:root });
  await bridge.sendTurn({ threadId:'tick-thread', input:'task-tick' });
  await until(() => events.some((event) => event.type==='task.progress' && typeof event.payload?.description==='string' && event.payload.description.includes('running read')));
  const progress = events.find((event) => event.type==='task.progress' && event.payload.description.includes('running read'));
  assert.equal(typeof progress.payload.taskId, 'string');
  assert.ok(progress.payload.taskId.length > 0);
  assert.equal(progress.payload.agentKind, 'agent');
  assert.equal(progress.payload.lastToolName, 'read src/foo.ts');
  assert.match(progress.payload.description, /Audit auth · running read src\/foo\.ts/);
});

test('rewinding a Rubato thread forks Pi history, rebinds the live session, and keeps the next prompt on that cursor', async (t) => {
  const { root, service, events, bridge } = await setup(t);
  const session = await bridge.startSession({ threadId:'rewind-thread', runtimeMode:'full-access', cwd:root });
  const originalId = session.resumeCursor.sessionId;
  await bridge.sendTurn({ threadId:'rewind-thread', input:'first' });
  await until(() => events.filter((event) => event.type==='turn.completed').length >= 1);
  await bridge.sendTurn({ threadId:'rewind-thread', input:'second' });
  await until(() => events.filter((event) => event.type==='turn.completed').length >= 2);
  const before = await bridge.readThread('rewind-thread');
  assert.deepEqual(before.turns[0].items.filter((message) => message.role==='user').map(userContent), ['first', 'second']);
  await assert.rejects(bridge.rollbackThread('rewind-thread', 0), /integer >= 1/);
  await assert.rejects(bridge.rollbackThread('rewind-thread', 3), /more turns/);
  const rolled = await bridge.rollbackThread('rewind-thread', 1);
  const live = bridge.listSessions().find((item) => item.threadId==='rewind-thread');
  assert.notEqual(live.resumeCursor.sessionId, originalId, 'resume cursor stayed on the pre-fork session');
  assert.equal(bridge.sessions.get('rewind-thread').sessionId, live.resumeCursor.sessionId);
  assert.deepEqual(rolled.turns[0].items.filter((message) => message.role==='user').map(userContent), ['first']);
  assert.equal(events.filter((event) => event.type==='runtime.error').length, 0);
  const completed = events.filter((event) => event.type==='turn.completed').length;
  await bridge.sendTurn({ threadId:'rewind-thread', input:'edited' });
  await until(() => events.filter((event) => event.type==='turn.completed').length >= completed + 1);
  const after = await bridge.readThread('rewind-thread');
  assert.deepEqual(after.turns[0].items.filter((message) => message.role==='user').map(userContent), ['first', 'edited']);
  await bridge.recover();
  assert.equal(bridge.sessions.get('rewind-thread').sessionId, live.resumeCursor.sessionId);
  assert.equal(service.host.getSessionWorker(live.resumeCursor.sessionId)?.metadata.id, live.resumeCursor.sessionId);
  assert.equal(service.host.getSessionWorker(originalId), undefined, 'host kept the worker keyed on the abandoned session');
});

test('catalogue lists Rubato control commands and hides TUI duplicates', async (t) => {
  const { root, bridge } = await setup(t);
  const catalogue = await bridge.catalogue(root);
  assert.deepEqual(catalogue.slashCommands.map((item) => item.name), ['compact', 'name', 'reload']);
  assert.equal(catalogue.skills.length, 0);
  assert.equal(catalogue.slashCommands.some((item) => item.name === 'model' || item.name === 'fork'), false);
});

test('an extension command typed as composer text still reaches Pi as a prompt', async (t) => {
  const { root, events, bridge } = await setup(t);
  await bridge.startSession({ threadId:'ext-thread', runtimeMode:'full-access', cwd:root });
  const context = bridge.sessions.get('ext-thread');
  const calls = [];
  const original = context.client.command.bind(context.client);
  context.client.command = async (command) => { calls.push(command); return original(command); };
  await bridge.sendTurn({ threadId:'ext-thread', input:'/audit now' });
  assert.equal(calls.at(-1).type, 'prompt');
  assert.equal(calls.at(-1).message, '/audit now');
  await until(() => events.some((event) => event.type==='turn.completed'));
});

test('a control command typed as composer text becomes its RPC command and T3 is told', async (t) => {
  const { root, events, bridge } = await setup(t);
  await bridge.startSession({ threadId:'ctl-thread', runtimeMode:'full-access', cwd:root });
  const context = bridge.sessions.get('ctl-thread');
  const calls = [];
  const original = context.client.command.bind(context.client);
  context.client.command = async (command) => {
    calls.push(command);
    if (command.type === 'compact' || command.type === 'reload') return { ok: true };
    return original(command);
  };
  await bridge.sendTurn({ threadId:'ctl-thread', input:'/compact keep the plan' });
  assert.deepEqual(calls.filter((command) => command.type !== 'get_state'), [
    { type: 'compact', customInstructions: 'keep the plan' },
  ]);
  assert.ok(events.some((event) => event.type==='thread.state.changed' && event.payload.state==='compacted'));
  calls.length = 0;
  await bridge.sendTurn({ threadId:'ctl-thread', input:'/name Rewound' });
  assert.deepEqual(calls.filter((command) => command.type === 'set_session_name'), [{ type: 'set_session_name', name: 'Rewound' }]);
  assert.ok(events.some((event) => event.type==='thread.metadata.updated' && event.payload.name==='Rewound'));
});

test('a $skill chip is rewritten to /skill:name so Pi expands it', async (t) => {
  const { root, events, bridge } = await setup(t);
  await bridge.startSession({ threadId:'skill-thread', runtimeMode:'full-access', cwd:root });
  bridge.skillNames = new Set(['ship-it']);
  const context = bridge.sessions.get('skill-thread');
  const calls = [];
  const original = context.client.command.bind(context.client);
  context.client.command = async (command) => { calls.push(command); return original(command); };
  await bridge.sendTurn({ threadId:'skill-thread', input:'$ship-it the patch' });
  assert.equal(calls.at(-1).type, 'prompt');
  assert.equal(calls.at(-1).message, '/skill:ship-it the patch');
  await until(() => events.some((event) => event.type==='turn.completed'));
});

test('native compact issues the compact RPC and reports compacted to T3', async (t) => {
  const { root, events, bridge } = await setup(t);
  await bridge.startSession({ threadId:'cmp-thread', runtimeMode:'full-access', cwd:root });
  const context = bridge.sessions.get('cmp-thread');
  const calls = [];
  const original = context.client.command.bind(context.client);
  context.client.command = async (command) => {
    calls.push(command);
    if (command.type === 'compact') return { ok: true };
    return original(command);
  };
  await bridge.compact('cmp-thread');
  assert.deepEqual(calls.filter((command) => command.type !== 'get_state'), [{ type: 'compact' }]);
  assert.ok(events.some((event) => event.type==='thread.state.changed' && event.payload.state==='compacted'));
});

test('compaction_end from Pi is thread.state.changed compacted', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'compaction_end', reason:'manual', aborted:false});
  assert.equal(events.some((event) => event.type==='thread.state.changed' && event.payload.state==='compacted'), true);
  p.project({type:'compaction_end', reason:'manual', aborted:true});
  assert.equal(events.filter((event) => event.type==='thread.state.changed').length, 1);
});
