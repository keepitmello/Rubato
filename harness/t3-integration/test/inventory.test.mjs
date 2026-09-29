import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { SessionClient } from '../../pi-server/src/client.mjs';
import { EventProjection } from '../src/events.mjs';
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
  // 두 프로젝트는 실재하는 작업 폴더여야 한다. 앱은 임시 폴더에서 돈 세션을
  // 목록에 올리지 않는다(bridge.mjs 의 userStartedSession). 세션 파일은 여전히
  // 임시 agentDir 에 쌓이고, 여기 폴더는 읽히지도 쓰이지도 않는다.
  const here=fileURLToPath(new URL('..',import.meta.url));
  const cwdA=path.join(here,'src'),cwdB=path.join(here,'test');
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
    let detailReads=0;
    const query={getCommandReadModel:()=>Effect.sync(()=>model),getThreadDetailById:id=>Effect.sync(()=>{detailReads+=1;return Option.fromUndefinedOr(model.threads.find(thread=>thread.id===id));})};
    const service={startSession:(_id,input)=>instance.adapter.startSession(input)};
    const inventory=yield* makeRubatoPiInventory.pipe(
      Effect.provideService(ProviderInstanceRegistry,registry),Effect.provideService(ProviderSessionDirectory,directory),
      Effect.provideService(ProjectionSnapshotQuery,query),Effect.provideService(OrchestrationEngineService,engine),Effect.provideService(ProviderService,service));
    yield* inventory.sync;
    assert.equal(model.projects.length,2);assert.equal(model.threads.length,3);assert.equal(bindings.size,3);
    assert.equal(server.host.metrics.runtimeStarts,1);
    assert.equal((yield* Effect.promise(()=>external.snapshot())).runtimeId,original.runtimeId);
    const imported=model.threads.find(thread=>bindings.get(thread.id).resumeCursor.sessionId===two.sessionId);
    assert.ok(imported);
    // A session already running when T3 first sees it still brings the prompt it
    // was started with: the live replay carries assistant messages only.
    const liveImports=commands.filter((command)=>command.type==='thread.history.import' && command.threadId===imported.id);
    assert.equal(liveImports.length,1);
    assert.deepEqual(liveImports[0].messages.map((message)=>[message.role,message.text]),[['user','background']]);
    assert.deepEqual(model.threads.find((thread)=>thread.id===imported.id).messages.map((message)=>[message.role,message.text]),[['user','background']]);
    const count=commands.length;
    const reads=detailReads;
    yield* inventory.sync;
    assert.equal(commands.length,count);
    // The sync runs every five seconds over every stored session. A thread whose
    // history was already checked must not load its whole detail again: 205 of
    // them did, 369 SQL statements a second and a 10 MB trace file every 30 s.
    assert.equal(detailReads,reads,'a checked thread is not read again');assert.equal(model.threads.length,3);assert.equal(bindings.size,3);
    assert.equal(server.host.metrics.runtimeStarts,1);
    yield* engine.dispatch({type:'thread.archive',commandId:contracts.CommandId.make('archive-test'),threadId:imported.id});
    yield* instance.adapter.stopSession(imported.id);
    yield* inventory.sync;
    assert.equal((yield* instance.adapter.listSessions()).length,0);
    assert.equal((yield* Effect.promise(()=>external.snapshot())).state.isStreaming,true);
    assert.deepEqual(new Set([...bindings.values()].map(v=>v.resumeCursor.sessionId)),new Set([one.sessionId,two.sessionId,three.sessionId]));
  })).pipe(Effect.provideService(Crypto.Crypto,crypto)));
});

// A message another conversation sent into a Pi session reaches the T3 thread as its
// own message: from stored history, read through the engine's real transcript of Pi
// session files, and live, through the writer the inventory binds on the bridge.
// T3 runs its real engine and SQLite projection here, because there a message id is
// one key across all threads: a fork carries the sender's messageId into a second
// thread, and a decider or in-memory projector cannot see one thread taking the
// other's row.
test('inventory brings session messages into each thread with their sender, keeps a fork from taking the original bubble, and dedups a replay', {skip:!process.env.T3_SOURCE}, async (t) => {
  const source = process.env.T3_SOURCE;
  const modules = t3Modules(source);
  const from = modules.source;
  const [Effect, Layer, ManagedRuntime, Option, PubSub, Crypto] = await Promise.all(['Effect','Layer','ManagedRuntime','Option','PubSub','Crypto'].map(name=>modules.effect(name)));
  const NodeServices = await import(pathToFileURL(createRequire(path.join(source,'apps/server/package.json')).resolve('@effect/platform-node/NodeServices')));
  const {RubatoPiDriver, rubatoBridgeFor} = await from('apps/server/src/provider/Drivers/RubatoPiDriver.ts');
  const {makeRubatoPiInventory} = await from('apps/server/src/provider/RubatoPiInventory.ts');
  const {ProviderInstanceRegistry} = await from('apps/server/src/provider/Services/ProviderInstanceRegistry.ts');
  const {ProviderSessionDirectory} = await from('apps/server/src/provider/Services/ProviderSessionDirectory.ts');
  const {ProviderService} = await from('apps/server/src/provider/Services/ProviderService.ts');
  const {ProjectionSnapshotQuery} = await from('apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts');
  const {OrchestrationEngineService} = await from('apps/server/src/orchestration/Services/OrchestrationEngine.ts');
  const {OrchestrationEngineLive} = await from('apps/server/src/orchestration/Layers/OrchestrationEngine.ts');
  const {OrchestrationProjectionPipelineLive} = await from('apps/server/src/orchestration/Layers/ProjectionPipeline.ts');
  const {OrchestrationProjectionSnapshotQueryLive} = await from('apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts');
  const ThreadBackgroundLiveness = await from('apps/server/src/orchestration/ThreadBackgroundLiveness.ts');
  const ThreadPlanProgress = await from('apps/server/src/orchestration/ThreadPlanProgress.ts');
  const {OrchestrationEventStoreLive} = await from('apps/server/src/persistence/Layers/OrchestrationEventStore.ts');
  const {OrchestrationCommandReceiptRepositoryLive} = await from('apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts');
  const RepositoryIdentityResolver = await from('apps/server/src/project/RepositoryIdentityResolver.ts');
  const {SqlitePersistenceMemory} = await from('apps/server/src/persistence/Layers/Sqlite.ts');
  const {ServerConfig} = await from('apps/server/src/config.ts');
  const contracts = await from('packages/contracts/src/index.ts');
  // Pi's own session writer, from the engine's dependency (an import-only package).
  const piPackage = findPackageJSON('@earendil-works/pi-coding-agent',new URL('../../pi-server/package.json',import.meta.url));
  const pi = await import(pathToFileURL(path.join(path.dirname(piPackage),JSON.parse(await readFile(piPackage,'utf8')).exports['.'].import)));
  const crypto = Crypto.make({randomBytes:size=>randomBytes(size),digest:(algorithm,data)=>Effect.succeed(createHash(algorithm.replace('-','').toLowerCase()).update(data).digest())});
  const root = await mkdtemp(path.join(tmpdir(),'rb-inventory-'));
  const cwd=fileURLToPath(new URL('../src',import.meta.url));
  // T3's own orchestration test wiring (OrchestrationEngine.test.ts), on in-memory SQLite.
  const runtime=ManagedRuntime.make(Layer.mergeAll(
    OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive),Layer.provide(OrchestrationProjectionPipelineLive)),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(Layer.provideMerge(ThreadBackgroundLiveness.layer),Layer.provide(ThreadPlanProgress.layer),Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),Layer.provide(RepositoryIdentityResolver.layer),Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(cwd,path.join(root,'t3'))),Layer.provideMerge(NodeServices.layer)));
  const server = await serveProfile({agentDir:root,idleMs:50,workerFactory:metadata=>new RpcWorker(metadata,{cliPath:fixture})});
  t.after(async()=>{await runtime.dispose();await server.close();await rm(root,{recursive:true,force:true});});
  // Pi session files as Pi writes them: the original received a message, and a fork
  // is Pi's header over a copy of that history (the engine's session_fork).
  const sessionsDir=path.join(root,'sessions');
  const planner={sessionId:'sender',title:'Planner',cwd};
  const original=pi.SessionManager.create(cwd,sessionsDir);
  original.appendSessionInfo('Receiver');
  original.appendCustomMessageEntry('rubato-session-message','<session-message>Start on the release notes.</session-message>',true,
    {v:1,messageId:'m-create',kind:'create',from:planner,text:'Start on the release notes.'});
  original.appendCustomMessageEntry('rubato-runtime:wake','wake',false,undefined);
  const now=Date.now();
  original.appendMessage({role:'assistant',content:[{type:'text',text:'On it.'}],api:'fixture',provider:'fixture',model:'fixture',
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:now+1000});
  original.appendMessage({role:'user',content:'thanks',timestamp:now+2000});
  const copied=pi.parseSessionEntries(await readFile(original.getSessionFile(),'utf8')).filter(entry=>entry.type!=='session');
  const fork=pi.SessionManager.create(cwd,sessionsDir,{parentSession:original.getSessionFile()});
  await writeFile(fork.getSessionFile(),[fork.getHeader(),...copied].map(entry=>JSON.stringify(entry)).join('\n')+'\n',{flag:'wx'});
  const commands=[];const bindings=new Map();
  await runtime.runPromise(Effect.scoped(Effect.gen(function*(){
    const t3=yield* OrchestrationEngineService;
    const query=yield* ProjectionSnapshotQuery;
    const instance=yield* RubatoPiDriver.create({instanceId:contracts.ProviderInstanceId.make('rubato-test'),displayName:undefined,environment:[],enabled:true,
      config:{bridgeModule:fileURLToPath(new URL('../src/bridge.mjs',import.meta.url)),descriptorPath:server.descriptorPath,catalogueCwd:cwd}});
    const bridge=rubatoBridgeFor(instance);
    const changes=yield* PubSub.unbounded();
    yield* Effect.addFinalizer(()=>PubSub.shutdown(changes));
    const registry={listInstances:Effect.succeed([instance]),subscribeChanges:PubSub.subscribe(changes)};
    const engine={dispatch:command=>{commands.push(command);return t3.dispatch(command);}};
    const directory={listBindings:()=>Effect.sync(()=>[...bindings.values()]),upsert:(value,options)=>Effect.sync(()=>{
      if(options?.onConflict==='ignore'&&bindings.has(value.threadId))return;
      bindings.set(value.threadId,value);
    })};
    const service={startSession:(_id,input)=>instance.adapter.startSession(input)};
    const inventory=yield* makeRubatoPiInventory.pipe(
      Effect.provideService(ProviderInstanceRegistry,registry),Effect.provideService(ProviderSessionDirectory,directory),
      Effect.provideService(ProjectionSnapshotQuery,query),Effect.provideService(OrchestrationEngineService,engine),Effect.provideService(ProviderService,service));
    yield* inventory.sync;
    const threadOf=(sessionId)=>[...bindings.values()].find(binding=>binding.resumeCursor.sessionId===sessionId).threadId;
    const receiver=threadOf(original.getSessionId()),forked=threadOf(fork.getSessionId());
    assert.notEqual(receiver,forked);
    // Read back from SQLite, as the app loads a thread.
    const messagesOf=(threadId)=>query.getThreadDetailById(threadId).pipe(Effect.map(thread=>Option.getOrThrow(thread).messages));
    const shown=(threadId)=>messagesOf(threadId).pipe(Effect.map(messages=>messages.toSorted((a,b)=>a.createdAt.localeCompare(b.createdAt))
      .map(message=>[message.role,message.text,message.context?.records?.[0]?.label ?? null])));
    const history=[['user','Start on the release notes.','Planner'],['assistant','On it.',null],['user','thanks',null]];
    assert.deepEqual(yield* shown(receiver),history,'the original shows its received message with the fork imported beside it');
    assert.deepEqual(yield* shown(forked),history,'the fork shows its own copy');
    for (const threadId of [receiver,forked]) {
      const [linked]=(yield* messagesOf(threadId)).filter(message=>message.context);
      assert.equal(linked.context.records[0].kind,'rubato-session');
      assert.deepEqual(linked.context.records[0].payload.from,planner);
      assert.equal(linked.context.records[0].payload.kind,'create');
      assert.equal(linked.context.records[0].payload.messageId,'m-create');
    }
    assert.equal(commands.filter(command=>command.type==='thread.turn.start').length,0,'a session message starts no T3 turn');
    // Live: what the attached session's projection hands the writer the inventory
    // bound on the bridge. A rewind rebinds the original thread to another Pi session
    // whose history still holds the message: the replay is refused and one bubble stays.
    const liveItem=(threadId,sessionId,message)=>{
      const items=[];
      new EventProjection({threadId,sessionId,instanceId:'rubato-test',emit:()=>{},sessionMessage:item=>items.push(item)}).message(message,true);
      assert.equal(items.length,1);
      return items[0];
    };
    const received=(messageId,kind,text,timestamp)=>({role:'custom',customType:'rubato-session-message',display:true,
      content:`<session-message>${text}</session-message>`,details:{v:1,messageId,kind,from:planner,text},timestamp});
    const replay=liveItem(receiver,fork.getSessionId(),received('m-create','create','Start on the release notes.',now));
    yield* Effect.promise(()=>bridge.appendSessionMessage(receiver,replay).then(()=>assert.fail('replay accepted'),()=>{}));
    const later=liveItem(forked,fork.getSessionId(),received('m-live','message','Also update the docs.',now+3000));
    yield* Effect.promise(()=>bridge.appendSessionMessage(forked,later));
    assert.deepEqual(yield* shown(receiver),history);
    assert.deepEqual(yield* shown(forked),[...history,['user','Also update the docs.','Planner']]);
  })).pipe(Effect.provideService(Crypto.Crypto,crypto)));
});
