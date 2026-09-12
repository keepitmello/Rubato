import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { SessionClient } from '../../pi-server/src/client.mjs';
const fixture = fileURLToPath(new URL('../../pi-server/test/fixtures/rpc.mjs', import.meta.url));

test('actual T3 Driver factory, adapter contracts and scope cleanup use a non-owning Pi attachment', {skip: !process.env.T3_SOURCE}, async (t) => {
  const source = process.env.T3_SOURCE;
  const Effect = await import(pathToFileURL(path.join(source, 'node_modules/effect/dist/Effect.js')));
  const { RubatoPiDriver, rubatoBridgeFor } = await import(pathToFileURL(path.join(source, 'apps/server/src/provider/Drivers/RubatoPiDriver.ts')));
  const { ProviderInstanceId, ThreadId } = await import(pathToFileURL(path.join(source, 'packages/contracts/src/index.ts')));
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
