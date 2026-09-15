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
test('continuation without a live Pi turn settles instead of leaving thinking open', async (t) => {
  const { root, events, bridge } = await setup(t);
  await bridge.startSession({ threadId:'idle-thread', runtimeMode:'full-access', cwd:root });
  const before = events.filter((event) => event.type==='turn.started').length;
  await assert.rejects(
    () => bridge.sendTurn({ threadId:'idle-thread', continuation:true }),
    /no running turn/,
  );
  const context = bridge.sessions.get('idle-thread');
  assert.equal(context.session.status, 'ready');
  assert.equal(context.projection.turnId, undefined);
  assert.equal(events.filter((event) => event.type==='turn.started').length, before);
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
  assert.equal(started?.payload.taskId, 'st_1');
  assert.equal(started.payload.agentKind, 'agent');
  assert.equal(started.payload.taskType, 'subagent');
  assert.equal(started.payload.title, 'Audit auth');
  assert.equal(started.payload.description, undefined);
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
  assert.equal(member.payload.title, 'Ship the patch');
  assert.equal(member.payload.description, undefined);
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_1', task_summary:'Audit auth', status:'running',
    live_progress:{ activity:'Audit auth · running grep TODO', started_at:2000, current_tool:'grep TODO',
      last_assistant_line:'found three', turns:2, tool_calls:3 },
  }]}});
  const live = events.filter((event) => event.type==='task.progress' && event.payload.lastToolName==='grep TODO');
  assert.equal(live.length, 1);
  assert.equal(live[0].payload.taskId, started.payload.taskId, 'live tick must keep the child taskId');
  assert.equal(live[0].payload.taskId, 'st_1');
  assert.equal(live[0].payload.lastToolName, 'grep TODO');
  assert.equal(live[0].payload.summary, 'found three');
  assert.equal(live[0].payload.description, 'found three');
  assert.equal(live[0].payload.agentKind, 'agent');
  assert.equal(live[0].payload.description.includes('Speed'), false);
  assert.equal(live[0].payload.description.includes('$'), false);
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
  assert.equal(ticks[0].payload.lastToolName, 'bash git status');
  assert.equal(ticks[0].payload.description, 'bash git status');
  assert.equal(ticks[0].payload.description.includes('Speed'), false);
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

test('a real Agent tool_execution_end payload opens one child row, and a tick emits task.progress', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'agent_start'});
  p.project({type:'tool_execution_start', toolName:'Agent', toolCallId:'toolu_spawn', args:{summary:'Audit auth', prompt:'Inspect auth'}});
  assert.equal(events.filter((event) => event.type==='task.started').length, 0, 'start must wait for agentId');
  // Shape taken from the live JSONL toolResult for Agent (content + details.agentId).
  p.project({type:'tool_execution_end', toolName:'Agent', toolCallId:'toolu_spawn', isError:false,
    result:{content:[{type:'text', text:'Started agent Audit auth (st_01a0a358, running).'}],
      details:{agentId:'st_01a0a358', status:'running', mode:'spawn', task_summary:'Audit auth', name:'st_01a0a358',
        execution_mode:'in-process', model:'xai/grok-4.6'}}});
  const started = events.filter((event) => event.type==='task.started');
  assert.equal(started.length, 1);
  assert.equal(started[0].payload.taskId, 'st_01a0a358');
  assert.equal(started[0].payload.toolUseId, 'toolu_spawn');
  assert.equal(started[0].payload.title, 'grok-4.6 · Audit auth');
  assert.equal(started[0].payload.description, undefined);
  const before = events.length;
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_01a0a358', task_summary:'Audit auth', status:'running', model:'xai/grok-4.6',
    live_progress:{ activity:'Audit auth · model:xai/grok-4.6 · turn 13 (18 tools) · running · $0.0000 · Speed 488',
      started_at:2000, current_tool:'read src/foo.ts', last_assistant_line:'looking at middleware', turns:13, tool_calls:18,
      total_tokens:1200, output_tokens:80 },
  }]}});
  const ticks = events.slice(before).filter((event) => event.type==='task.progress');
  assert.equal(ticks.length, 1, 'a running snapshot must emit task.progress');
  assert.equal(ticks[0].payload.taskId, 'st_01a0a358');
  assert.equal(ticks[0].payload.lastToolName, 'read src/foo.ts');
  assert.equal(ticks[0].payload.summary, 'looking at middleware');
  assert.equal(ticks[0].payload.description, 'looking at middleware');
  assert.equal(ticks[0].payload.status, 'running');
  assert.equal(ticks[0].payload.title, 'grok-4.6 · Audit auth');
  assert.equal(JSON.stringify(ticks[0].payload).includes('Speed 488'), false);
  assert.equal(JSON.stringify(ticks[0].payload).includes('$0.0000'), false);
  assert.equal(ticks[0].payload.typedUsage?.totalTokens, 1200);
  assert.equal(events.filter((event) => event.type==='task.started').length, 1);
});

test('a snapshot that arrives before spawn-ack still opens only one row', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'agent_start'});
  p.project({type:'tool_execution_start', toolName:'Agent', toolCallId:'toolu_spawn', args:{summary:'Audit auth'}});
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_01a0a358', task_summary:'Audit auth', status:'running', model:'xai/grok-4.6',
  }]}});
  p.project({type:'tool_execution_end', toolName:'Agent', toolCallId:'toolu_spawn', isError:false,
    result:{content:[{type:'text', text:'Started'}], details:{agentId:'st_01a0a358', status:'running', task_summary:'Audit auth', model:'xai/grok-4.6'}}});
  const started = events.filter((event) => event.type==='task.started');
  assert.equal(started.length, 1);
  assert.equal(started[0].payload.taskId, 'st_01a0a358');
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_01a0a358', task_summary:'Audit auth', status:'running',
    live_progress:{ current_tool:'read src/foo.ts', last_assistant_line:'looking at middleware', started_at:1 },
  }]}});
  const tick = events.find((event) => event.type==='task.progress' && event.payload.lastToolName==='read src/foo.ts');
  assert.equal(tick.payload.taskId, 'st_01a0a358');
  assert.equal(tick.payload.toolUseId, 'toolu_spawn');
});

test('a resync snapshot does not grow the task.started row count', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'agent_start'});
  p.project({type:'tool_execution_end', toolName:'Agent', toolCallId:'toolu_spawn', isError:false,
    result:{content:[{type:'text', text:'Started'}], details:{agentId:'st_live', status:'running', task_summary:'Audit auth', model:'fixture/model'}}});
  const snapshot = {type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_live', task_summary:'Audit auth', status:'running', model:'fixture/model',
    live_progress:{ activity:'Audit auth · running read src/foo.ts', started_at:2000,
      current_tool:'read src/foo.ts', last_assistant_line:'looking at middleware', turns:1, tool_calls:1 },
  }]}};
  p.project(snapshot);
  const starts = events.filter((event) => event.type==='task.started').length;
  const progress = events.filter((event) => event.type==='task.progress').length;
  assert.equal(starts, 1);
  assert.ok(progress >= 1, 'tick must produce task.progress');
  // synchronize() replays the snapshot without reset(); maps persist, so a second
  // announcement of the same running child must not open another start row.
  p.project(snapshot);
  p.project(snapshot);
  assert.equal(events.filter((event) => event.type==='task.started').length, starts);
  assert.equal(new Set(events.filter((event) => event.type==='task.started').map((event) => event.payload.taskId)).size, 1);
});

test('spawn item and task share a toolCallId so mobile can drop the tool row', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'agent_start'});
  p.project({type:'tool_execution_start', toolName:'Agent', toolCallId:'toolu_spawn',
    args:{summary:'Audit auth', model:'xai/grok-4.6', effort:'high'}});
  p.project({type:'tool_execution_end', toolName:'Agent', toolCallId:'toolu_spawn', isError:false,
    result:{details:{agentId:'st_01', status:'running', task_summary:'Audit auth', model:'xai/grok-4.6'}}});
  const item = events.find((event) => event.type==='item.started' && event.payload.itemType==='collab_agent_tool_call');
  const task = events.find((event) => event.type==='task.started');
  assert.equal(item.itemId, 'toolu_spawn');
  assert.equal(item.payload.data.toolCallId, 'toolu_spawn');
  assert.equal(task.payload.toolUseId, 'toolu_spawn');
  assert.equal(item.itemId, task.payload.toolUseId);
});

test('subagent model and effort stay structured and reach the title mobile paints', () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.project({type:'agent_start'});
  p.project({type:'tool_execution_start', toolName:'Agent', toolCallId:'toolu_spawn',
    args:{summary:'재연결 직후 잘못된 컨텍스트 창 크기 전송 수정', model:'xai/grok-4.6', effort:'high', prompt:'do the work'}});
  p.project({type:'tool_execution_end', toolName:'Agent', toolCallId:'toolu_spawn', isError:false,
    result:{details:{agentId:'st_01', status:'running', task_summary:'재연결 직후 잘못된 컨텍스트 창 크기 전송 수정',
      model:'xai/grok-4.6', resolved_model:{reasoning:'high', reasoning_effort:'high'}}}});
  const started = events.find((event) => event.type==='task.started');
  assert.equal(started.payload.model, 'xai/grok-4.6');
  assert.equal(started.payload.effort, 'high');
  assert.equal(started.payload.title.includes('xai/'), false);
  assert.equal(started.payload.title.includes('grok-4.6'), true);
  assert.equal(started.payload.title.includes('high'), true);
  assert.ok(started.payload.title.length <= 37, started.payload.title);
  p.project({type:'extension_event', name:'rubato.task.updated', data:{ parent_session_id:'session', tasks:[{
    task_id:'st_01', task_summary:'재연결 직후 잘못된 컨텍스트 창 크기 전송 수정', status:'running', model:'xai/grok-4.6', effort:'high',
    live_progress:{ last_assistant_line:"I will start from the usage-reporting commit", current_tool:'read events.mjs' },
  }]}});
  const tick = events.find((event) => event.type==='task.progress');
  assert.equal(tick.payload.description, "I will start from the usage-reporting commit");
  assert.equal(tick.payload.description.includes('grok'), false);
  assert.equal(tick.payload.model, 'xai/grok-4.6');
  assert.equal(tick.payload.effort, 'high');
  assert.equal(tick.payload.title.includes('grok-4.6'), true);
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
  await until(() => events.some((event) => event.type==='task.progress' && event.payload?.lastToolName==='read src/foo.ts'));
  const progress = events.find((event) => event.type==='task.progress' && event.payload.lastToolName==='read src/foo.ts');
  assert.equal(typeof progress.payload.taskId, 'string');
  assert.ok(progress.payload.taskId.length > 0);
  assert.equal(progress.payload.agentKind, 'agent');
  assert.equal(progress.payload.lastToolName, 'read src/foo.ts');
  assert.equal(progress.payload.summary, 'looking at middleware');
  assert.equal(progress.payload.description.includes('Speed'), false);
  assert.equal(progress.payload.description.includes('$0'), false);
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

test('assistant usage becomes thread.token-usage.updated in the meter shape', async () => {
  const events=[]; const p=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  p.configureUsage({ maxTokens: 200000, compactsAutomatically: true });
  p.project({type:'agent_start'});
  p.project({type:'message_end', message:{role:'assistant', timestamp:1, model:'fixture', stopReason:'stop',
    content:[{type:'text', text:'ok'}],
    usage:{ input:100, output:20, cacheRead:50, cacheWrite:0, reasoning:8, totalTokens:170 }}});
  p.project({type:'agent_settled'});
  const usage = events.find((event) => event.type==='thread.token-usage.updated');
  assert.ok(usage, 'meter event was not emitted');
  assert.deepEqual(usage.payload.usage, {
    usedTokens: 170, lastUsedTokens: 170, maxTokens: 200000,
    inputTokens: 100, lastInputTokens: 100,
    cachedInputTokens: 50, lastCachedInputTokens: 50,
    outputTokens: 20, lastOutputTokens: 20,
    reasoningOutputTokens: 8, lastReasoningOutputTokens: 8,
    compactsAutomatically: true,
  });
  assert.equal('totalProcessedTokens' in usage.payload.usage, false);
  assert.equal('autoCompactThreshold' in usage.payload.usage, false);
  assert.equal('toolUses' in usage.payload.usage, false);
  p.project({type:'message_end', message:{role:'assistant', timestamp:2, stopReason:'aborted',
    usage:{ input:1, output:1, cacheRead:0, cacheWrite:0, totalTokens:2 }}});
  p.project({type:'message_end', message:{role:'assistant', timestamp:3, stopReason:'stop'}});
  assert.equal(events.filter((event) => event.type==='thread.token-usage.updated').length, 1);
  if (process.env.T3_SOURCE) {
    const { deriveLatestContextWindowSnapshot } = await import(`${process.env.T3_SOURCE}/apps/web/src/lib/contextWindow.ts`);
    const meter = deriveLatestContextWindowSnapshot([{
      kind: 'context-window.updated', payload: usage.payload.usage, createdAt: usage.createdAt,
    }]);
    assert.equal(meter.usedTokens, 170);
    assert.equal(meter.maxTokens, 200000);
    assert.equal(meter.usedPercentage, 170 / 200000 * 100);
    assert.equal(meter.compactsAutomatically, true);
    assert.equal(meter.totalProcessedTokens, null);
  }
});

test('attach replays last assistant usage and stays silent after compaction', () => {
  const events=[]; const projection=new EventProjection({threadId:'thread',sessionId:'session',instanceId:'instance',emit:event=>events.push(decodeEvent(event))});
  projection.configureUsage({ maxTokens: 200000, compactsAutomatically: true });
  const bridge = Object.create(RubatoPiBridge.prototype);
  const context = { projection };
  const usage = { input:100, output:20, cacheRead:50, cacheWrite:0, reasoning:8, totalTokens:170 };
  bridge.replayUsage(context, [{ role:'user', content:'hi' }, { role:'assistant', stopReason:'stop', usage }]);
  const event = events.find((item) => item.type==='thread.token-usage.updated');
  assert.equal(event.payload.usage.usedTokens, 170);
  assert.equal(event.payload.usage.maxTokens, 200000);
  events.length = 0; projection.lastUsage = undefined;
  bridge.replayUsage(context, [{ role:'assistant', stopReason:'stop', usage }, { role:'compactionSummary' }]);
  assert.equal(events.length, 0, 'pre-compaction usage must not become the meter after compact');
});

const CATALOGUE = [
  { provider:'anthropic', id:'claude-opus-5', contextWindow:1000000 },
  { provider:'xai', id:'grok-4.6', contextWindow:500000 },
  { provider:'openai-codex', id:'gpt-5.6-sol', contextWindow:272000 },
  { provider:'openai-codex', id:'gpt-5.6-terra', contextWindow:272000 },
];
const reattachContext = ({ stateModel, knownModel, maxTokens, models = CATALOGUE } = {}) => {
  const events = [];
  const projection = new EventProjection({ threadId:'thread', sessionId:'session', instanceId:'instance',
    emit:(event) => events.push(decodeEvent(event)) });
  if (maxTokens) projection.configureUsage({ maxTokens });
  const bridge = Object.create(RubatoPiBridge.prototype);
  bridge.projectedMessages = async () => [];
  bridge.rememberWindows(models);
  bridge.catalogue = async () => ({ models });
  const usage = { input:2, output:962, cacheRead:489090, cacheWrite:0, reasoning:0, totalTokens:490570 };
  const snapshot = {
    runtimeId:'rt', sequence:1, pendingUi:[],
    state:{ isStreaming:false, model:stateModel, autoCompactionEnabled:true },
    messages:[
      { role:'user', content:'hi' },
      { role:'assistant', stopReason:'stop', provider:'anthropic', model:'claude-opus-5',
        timestamp:1, content:[{ type:'text', text:'ok' }], usage },
    ],
  };
  const context = {
    session:{ threadId:'thread', status:'connecting', resumeCursor:{ kind:'rubato-pi' },
      ...(knownModel ? { model:knownModel } : {}) },
    projection,
    client:{ subscribeSession: async () => () => {}, snapshot: async () => snapshot },
  };
  return { events, bridge, context };
};

test('reattach publishes the session model window even when get_state answers another family', async () => {
  const { events, bridge, context } = reattachContext({
    stateModel:{ provider:'openai-codex', id:'gpt-5.6-sol', contextWindow:272000 },
  });
  await bridge.synchronize(context);
  const usageEvents = events.filter((event) => event.type === 'thread.token-usage.updated');
  assert.equal(usageEvents.length, 1);
  const usage = usageEvents[0].payload.usage;
  assert.equal(usage.usedTokens, 490570);
  assert.equal(usage.maxTokens, 1000000);
  assert.equal(usage.inputTokens, 2);
  assert.equal(usage.cachedInputTokens, 489090);
  assert.equal(usage.outputTokens, 962);
  assert.equal(usage.compactsAutomatically, true);
  assert.equal(usageEvents.some((event) => event.payload.usage.maxTokens === 272000), false);
});

test('reattach omits the window when the session model is not in the catalogue', async () => {
  const { events, bridge, context } = reattachContext({
    stateModel:{ provider:'openai-codex', id:'gpt-5.6-sol', contextWindow:272000 },
    models:[{ provider:'openai-codex', id:'gpt-5.6-sol', contextWindow:272000 }],
  });
  await bridge.synchronize(context);
  const usage = events.find((event) => event.type === 'thread.token-usage.updated');
  assert.equal(usage.payload.usage.usedTokens, 490570);
  assert.equal('maxTokens' in usage.payload.usage, false);
});

