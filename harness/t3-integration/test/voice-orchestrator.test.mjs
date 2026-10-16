// The voice submitter against T3's real orchestrator V2 (no provider: runs stay
// unstarted), through the same adapter the server route uses (RubatoVoice.ts).
// T3_SOURCE is a T3 checkout with the integration applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { t3Modules } from './t3-source.mjs';
import { createSubmitter, voiceMessageId, voiceThreadId } from '../src/voice/submit.mjs';

const source = process.env.T3_SOURCE;

async function orchestratorRuntime() {
  const t3 = t3Modules(source);
  const src = (relative) => t3.source(`apps/server/src/${relative}`);
  const [Layer, Effect, ManagedRuntime] = await Promise.all(['Layer', 'Effect', 'ManagedRuntime'].map(t3.effect));
  const [Orchestrator, ThreadManagementService, ProjectionStore, EventStore, EffectOutbox, ProviderAdapterRegistry,
    ProviderReplayHarness, CommandReceiptStore, SqlitePersistence, ServerSettings, Codex, Voice] = await Promise.all([
    'orchestration-v2/Orchestrator.ts', 'orchestration-v2/ThreadManagementService.ts', 'orchestration-v2/ProjectionStore.ts',
    'orchestration-v2/EventStore.ts', 'orchestration-v2/EffectOutbox.ts', 'orchestration-v2/ProviderAdapterRegistry.ts',
    'orchestration-v2/testkit/ProviderReplayHarness.ts', 'orchestration-v2/CommandReceiptStore.ts', 'persistence/Sqlite.ts',
    'serverSettings.ts', 'orchestration-v2/Adapters/CodexAdapterV2.ts', 'RubatoVoice.ts',
  ].map(src));
  const modelSelection = { instanceId: 'codex', model: 'gpt-5.1-codex' };
  const adapter = {
    instanceId: 'codex', driver: 'codex',
    getCapabilities: () => Effect.succeed(Codex.CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: 'apply_on_next_turn' }),
    openSession: () => Effect.die('Runs here never reach a provider'),
  };
  // The layer upstream's ThreadStop test uses: memory database, no effect worker.
  const db = SqlitePersistence.layerMemory;
  const layer = ThreadManagementService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(
      db,
      ProjectionStore.layer.pipe(Layer.provide(db)),
      EventStore.layer.pipe(Layer.provide(db)),
      EffectOutbox.layer.pipe(Layer.provide(db)),
      ProviderReplayHarness.layerWithRegistry({ name: 'rubato-voice' },
        ProviderAdapterRegistry.layerFromAdapters([adapter]), { databaseLayer: db, runEffectWorker: false }),
    )),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(db))),
  );
  const runtime = ManagedRuntime.make(layer);
  const orchestrator = await runtime.runPromise(Effect.service(Orchestrator.OrchestratorV2));
  const t3Voice = Voice.voiceOrchestrator(orchestrator);
  const projection = (threadId) => runtime.runPromise(orchestrator.getThreadProjection(threadId));
  return { runtime, t3Voice, projection, modelSelection };
}

const session = (id, threadId, text, extra = {}) => ({
  voiceSessionId: id, target: 'existing-thread', threadId, projectId: 'project:voice', text,
  createdAt: Date.now(), expiresAt: Date.now() + 600_000, ...extra,
});

test('T3 V2 queues a voice send behind the running turn, replays it once, and lets it be withdrawn', { skip: !source }, async (t) => {
  const { runtime, t3Voice, projection, modelSelection } = await orchestratorRuntime();
  t.after(() => runtime.dispose());
  const create = (threadId) => t3Voice.dispatch({
    type: 'thread.create', commandId: `create:${threadId}`, threadId, projectId: 'project:voice', title: threadId,
    modelSelection, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
    createdBy: 'user', creationSource: 'web',
  });
  const submitter = createSubmitter({ ...t3Voice, environmentId: 'env',
    readProject: async () => ({ id: 'project:voice', title: 'Voice', defaultModelSelection: modelSelection }) });

  // Busy thread: someone's message is the active run.
  await create('thread:busy');
  await t3Voice.dispatch({ type: 'message.dispatch', commandId: 'send:active', threadId: 'thread:busy',
    messageId: 'message:active', text: 'active', attachments: [], dispatchMode: { type: 'start_immediately' },
    createdBy: 'user', creationSource: 'web' });
  const queued = await submitter.submit(session('v-busy', 'thread:busy', 'voice after the turn'));
  assert.equal(queued.status, 'queued');
  const again = await submitter.submit(session('v-busy', 'thread:busy', 'voice after the turn'));
  assert.equal(again.runId, queued.runId);
  let busy = await projection('thread:busy');
  const voiceRun = busy.runs.find((run) => run.userMessageId === voiceMessageId('v-busy'));
  assert.equal(voiceRun.id, queued.runId);
  assert.equal(voiceRun.status, 'queued');
  const voiceMessage = busy.messages.filter((message) => message.id === voiceMessageId('v-busy'));
  assert.equal(voiceMessage.length, 1);
  assert.equal(voiceMessage[0].creationSource, 'mobile');

  assert.equal(await submitter.withdraw({ voiceSessionId: 'v-busy', threadId: 'thread:busy', runId: queued.runId }), true);
  busy = await projection('thread:busy');
  assert.equal(busy.runs.find((run) => run.id === queued.runId).status, 'cancelled');
  // The active run is not queued, so it cannot be withdrawn.
  const active = busy.runs.find((run) => run.userMessageId === 'message:active');
  assert.equal(await submitter.withdraw({ voiceSessionId: 'v-other', threadId: 'thread:busy', runId: active.id }), false);

  // Idle thread: the voice message starts its own run.
  await create('thread:idle');
  const sent = await submitter.submit(session('v-idle', 'thread:idle', 'voice now'));
  assert.equal(sent.status, 'sent');
  assert.notEqual((await projection('thread:idle')).runs.find((run) => run.id === sent.runId).status, 'queued');

  // New thread: created once with the project's model, the first message seeds its title.
  const fresh = session('v-new', undefined, 'brand new conversation', { target: 'new-thread' });
  const created = await submitter.submit(fresh);
  assert.equal(created.threadId, voiceThreadId('v-new'));
  assert.equal((await submitter.submit(fresh)).runId, created.runId);
  const shell = await t3Voice.readThread(created.threadId);
  assert.equal(shell.projectId, 'project:voice');
  assert.deepEqual((await projection(created.threadId)).messages.map((message) => message.text), ['brand new conversation']);
});
