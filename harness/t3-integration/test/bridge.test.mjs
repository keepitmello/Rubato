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
import { EventProjection } from '../src/events.mjs';
const fixture = fileURLToPath(new URL('../../pi-server/test/fixtures/rpc.mjs', import.meta.url));
const until = async (predicate) => { for (let i=0;i<300;i++) { if (await predicate()) return; await delay(10); } throw new Error('Condition did not settle'); };
let decodeEvent = (value) => value;
if (process.env.T3_SOURCE) {
  const { ProviderRuntimeEvent } = await import(`${process.env.T3_SOURCE}/packages/contracts/src/providerRuntime.ts`);
  const Schema = await import(`${process.env.T3_SOURCE}/node_modules/effect/dist/Schema.js`);
  decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
}
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-t3-'));
  const service = await serveProfile({ agentDir: root, idleMs: 60, workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: fixture }) });
  const events = [];
  const bridge = new RubatoPiBridge({ descriptorPath: service.descriptorPath, instanceId: 'rubato-test',
    emit: (event) => events.push(decodeEvent(event)) });
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
  const context = bridge.sessions.get('new-thread'); const runtimeId=context.runtimeId;
  context.client.client.disconnect(); await bridge.recover();
  assert.equal(context.runtimeId, runtimeId);
  assert.equal(service.host.metrics.runtimeStarts, 1);
  await bridge.respondToUserInput('new-thread','question-1',{'question-1':'yes'});
  await until(() => events.some((event) => event.type==='turn.completed'));
  assert.equal((await bridge.inventory())[0].sessionId, session.resumeCursor.sessionId);
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
