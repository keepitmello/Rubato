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
const until = async (predicate) => { for (let i=0;i<300;i++) { if (await predicate()) return; await delay(10); } throw new Error('Condition did not settle'); };
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
