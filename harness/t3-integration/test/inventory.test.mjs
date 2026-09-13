import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { SessionClient } from '../../pi-server/src/client.mjs';
import {t3Modules} from './t3-source.mjs';
const fixture = fileURLToPath(new URL('../../pi-server/test/fixtures/rpc.mjs', import.meta.url));

test('inventory uses real T3 decider/projector: groups stored history, preserves binding, attaches only live work', {skip:!process.env.T3_SOURCE}, async (t) => {
  const source = process.env.T3_SOURCE;
  const modules = t3Modules(source);
  const from = modules.source;
  const [Effect, Option, PubSub, Crypto, Schema] = await Promise.all(['Effect','Option','PubSub','Crypto','Schema'].map(name=>modules.effect(name)));
  const {RubatoPiDriver} = await from('apps/server/src/provider/Drivers/RubatoPiDriver.ts');
  const {makeRubatoPiInventory} = await from('apps/server/src/provider/RubatoPiInventory.ts');
  const {ProviderInstanceRegistry} = await from('apps/server/src/provider/Services/ProviderInstanceRegistry.ts');
  const {ProviderSessionDirectory} = await from('apps/server/src/provider/Services/ProviderSessionDirectory.ts');
  const {ProviderService} = await from('apps/server/src/provider/Services/ProviderService.ts');
  const {ProjectionSnapshotQuery} = await from('apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts');
  const {OrchestrationEngineService} = await from('apps/server/src/orchestration/Services/OrchestrationEngine.ts');
  const {createEmptyReadModel,projectEvent} = await from('apps/server/src/orchestration/projector.ts');
  const {decideOrchestrationCommand} = await from('apps/server/src/orchestration/decider.ts');
  const contracts = await from('packages/contracts/src/index.ts');
  const crypto = Crypto.make({randomBytes:size=>randomBytes(size),digest:(algorithm,data)=>Effect.succeed(createHash(algorithm.replace('-','').toLowerCase()).update(data).digest())});
  const root = await mkdtemp(path.join(tmpdir(),'rb-inventory-'));
  const cwdA=path.join(root,'project-A'),cwdB=path.join(root,'project-B');
  await mkdir(cwdA);await mkdir(cwdB);
  const server = await serveProfile({agentDir:root,idleMs:50,workerFactory:metadata=>new RpcWorker(metadata,{cliPath:fixture})});
  const external=await new SessionClient(server.descriptor).connect();
  t.after(async()=>{await external.close();await server.close();await rm(root,{recursive:true,force:true});});
  const one=await external.create({cwd:cwdA,title:'Idle A'});
  const two=await external.create({cwd:cwdA,title:'Live A'});
  const three=await external.create({cwd:cwdB,title:'Idle B'});
  await external.attach(two.sessionId);await external.command({type:'prompt',message:'background'});
  const original=await external.snapshot();
  const decode=Schema.decodeUnknownSync(contracts.OrchestrationCommand);
  const commands=[];const bindings=new Map();
  let model=createEmptyReadModel(new Date().toISOString());
  let sequence=0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
    const instance=yield* RubatoPiDriver.create({instanceId:contracts.ProviderInstanceId.make('rubato-test'),displayName:undefined,environment:[],enabled:true,
      config:{bridgeModule:fileURLToPath(new URL('../src/bridge.mjs',import.meta.url)),descriptorPath:server.descriptorPath,catalogueCwd:cwdA}});
    const changes=yield* PubSub.unbounded();
    yield* Effect.addFinalizer(()=>PubSub.shutdown(changes));
    const registry={listInstances:Effect.succeed([instance]),subscribeChanges:PubSub.subscribe(changes)};
    const engine={dispatch:input=>Effect.gen(function*(){
      const command=decode(input);commands.push(command);
      const decided=yield* decideOrchestrationCommand({command,readModel:model});
      for(const event of Array.isArray(decided)?decided:[decided]) model=yield* projectEvent(model,{...event,sequence:++sequence});
      return {sequence};
    })};
    const directory={listBindings:()=>Effect.sync(()=>[...bindings.values()]),upsert:(value,options)=>Effect.sync(()=>{
      if(options?.onConflict==='ignore'&&bindings.has(value.threadId))return;
      bindings.set(value.threadId,value);
    })};
    const query={getCommandReadModel:()=>Effect.sync(()=>model),getThreadDetailById:id=>Effect.sync(()=>Option.fromUndefinedOr(model.threads.find(thread=>thread.id===id)))};
    const service={startSession:(_id,input)=>instance.adapter.startSession(input)};
    const inventory=yield* makeRubatoPiInventory.pipe(
      Effect.provideService(ProviderInstanceRegistry,registry),Effect.provideService(ProviderSessionDirectory,directory),
      Effect.provideService(ProjectionSnapshotQuery,query),Effect.provideService(OrchestrationEngineService,engine),Effect.provideService(ProviderService,service));
    yield* inventory.sync;
    assert.equal(model.projects.length,2);assert.equal(model.threads.length,3);assert.equal(bindings.size,3);
    assert.equal(server.host.metrics.runtimeStarts,1);
    assert.equal((yield* Effect.promise(()=>external.snapshot())).runtimeId,original.runtimeId);
    const imported=model.threads.find(thread=>bindings.get(thread.id).resumeCursor.sessionId===two.sessionId);
    assert.equal(imported.messages[0].text,'background');
    assert.ok(commands.some(command=>command.type==='thread.history.import'));
    const count=commands.length;
    yield* inventory.sync;
    assert.equal(commands.length,count);assert.equal(model.threads.length,3);assert.equal(bindings.size,3);
    assert.equal(server.host.metrics.runtimeStarts,1);
    yield* engine.dispatch({type:'thread.archive',commandId:contracts.CommandId.make('archive-test'),threadId:imported.id});
    yield* instance.adapter.stopSession(imported.id);
    yield* inventory.sync;
    assert.equal((yield* instance.adapter.listSessions()).length,0);
    assert.equal((yield* Effect.promise(()=>external.snapshot())).state.isStreaming,true);
    assert.deepEqual(new Set([...bindings.values()].map(v=>v.resumeCursor.sessionId)),new Set([one.sessionId,two.sessionId,three.sessionId]));
  })).pipe(Effect.provideService(Crypto.Crypto,crypto)));
});
