import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { SessionClient } from '../../pi-server/src/client.mjs';
import {t3Modules} from './t3-source.mjs';
const fixture = fileURLToPath(new URL('../../pi-server/test/fixtures/rpc.mjs', import.meta.url));

test('actual T3 Driver factory, adapter contracts and scope cleanup use a non-owning Pi attachment', {skip: !process.env.T3_SOURCE}, async (t) => {
  const source = process.env.T3_SOURCE;
  const modules = t3Modules(source);
  const Effect = await modules.effect('Effect');
  const { RubatoPiDriver, rubatoBridgeFor } = await modules.source('apps/server/src/provider/Drivers/RubatoPiDriver.ts');
  const { ProviderInstanceId, ThreadId } = await modules.source('packages/contracts/src/index.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'rb-driver-'));
  const server = await serveProfile({agentDir:root, workerFactory:(metadata) => new RpcWorker(metadata,{cliPath:fixture})});
  const external = await new SessionClient(server.descriptor).connect();
  t.after(async () => { await external.close(); await server.close(); await rm(root,{recursive:true,force:true}); });
  const record = await external.create({cwd:root});
  await external.attach(record.sessionId);
  await external.command({type:'prompt',message:'background'});
  const before = await external.snapshot();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const instance = yield* RubatoPiDriver.create({instanceId:ProviderInstanceId.make('rubato-test'), displayName:undefined,
      environment:[],enabled:true,config:{bridgeModule:fileURLToPath(new URL('../src/bridge.mjs',import.meta.url)),descriptorPath:server.descriptorPath,catalogueCwd:root}});
    const bridge = rubatoBridgeFor(instance);
    bridge.projectedMessages = async () => [];
    const snapshot = yield* instance.snapshot.getSnapshot;
    assert.equal(snapshot.installed,true);
    assert.equal(snapshot.auth.status,'unknown');
    assert.equal(snapshot.supportsConversationRollback,true);
    assert.equal(instance.adapter.capabilities.supportsConversationRollback,true);
    const threadId = ThreadId.make('driver-thread');
    const session = yield* instance.adapter.startSession({threadId, runtimeMode:'full-access',resumeCursor:bridge.cursor(record.sessionId),cwd:root});
    assert.equal(session.status,'running');
    const result = yield* instance.adapter.sendTurn({threadId,continuation:true});
    assert.ok(result.turnId);
    const after = yield* Effect.promise(() => external.snapshot());
    assert.equal(after.runtimeId,before.runtimeId);
    assert.equal(after.messages.length,before.messages.length);
    yield* instance.adapter.stopSession(threadId);
    assert.equal((yield* Effect.promise(() => external.snapshot())).state.isStreaming,true);
  })));
  assert.equal((await external.snapshot()).runtimeId,before.runtimeId);
  assert.equal((await external.snapshot()).state.isStreaming,true);
});

test('T3 adapter rollback forks the Pi session and returns an updated resume cursor', {skip: !process.env.T3_SOURCE}, async (t) => {
  const source = process.env.T3_SOURCE;
  const modules = t3Modules(source);
  const Effect = await modules.effect('Effect');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { RubatoPiDriver, rubatoBridgeFor } = await modules.source('apps/server/src/provider/Drivers/RubatoPiDriver.ts');
  const { ProviderInstanceId, ThreadId } = await modules.source('packages/contracts/src/index.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'rb-driver-rewind-'));
  const server = await serveProfile({agentDir:root, workerFactory:(metadata) => new RpcWorker(metadata,{cliPath:fixture})});
  t.after(async () => { await server.close(); await rm(root,{recursive:true,force:true}); });
  const until = async (predicate) => { for (let i=0;i<300;i++) { if (await predicate()) return; await delay(10); } throw new Error('Condition did not settle'); };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const instance = yield* RubatoPiDriver.create({instanceId:ProviderInstanceId.make('rubato-rewind'), displayName:undefined,
      environment:[],enabled:true,config:{bridgeModule:fileURLToPath(new URL('../src/bridge.mjs',import.meta.url)),descriptorPath:server.descriptorPath,catalogueCwd:root}});
    const bridge = rubatoBridgeFor(instance);
    bridge.projectedMessages = async () => [];
    const threadId = ThreadId.make('driver-rewind');
    const session = yield* instance.adapter.startSession({threadId, runtimeMode:'full-access', cwd:root});
    const original = session.resumeCursor.sessionId;
    yield* instance.adapter.sendTurn({threadId, input:'first'});
    yield* Effect.promise(() => until(() => bridge.sessions.get(threadId)?.session.status === 'ready'));
    yield* instance.adapter.sendTurn({threadId, input:'second'});
    yield* Effect.promise(() => until(() => bridge.sessions.get(threadId)?.session.status === 'ready'));
    yield* instance.adapter.rollbackThread(threadId, 1);
    const live = (yield* instance.adapter.listSessions()).find((item) => item.threadId === threadId);
    assert.notEqual(live.resumeCursor.sessionId, original);
    const snapshot = yield* instance.adapter.readThread(threadId);
    const users = snapshot.turns[0].items.filter((message) => message.role==='user').map((message) =>
      typeof message.content === 'string' ? message.content : '');
    assert.deepEqual(users, ['first']);
  })));
});
