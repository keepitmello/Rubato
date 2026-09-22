import test from 'node:test';
import assert from 'node:assert/strict';
import { t3Modules } from './t3-source.mjs';

test('mobile provider marks cross the actual T3 RPC codecs without changing stored routes', {
  skip: !process.env.T3_SOURCE, timeout: 60000,
}, async t => {
  const modules = t3Modules(process.env.T3_SOURCE);
  const [Effect, Queue, Deferred, Stream, Schema, Option] = await Promise.all(
    ['Effect', 'Queue', 'Deferred', 'Stream', 'Schema', 'Option'].map(modules.effect));
  const { RpcGroup, RpcSerialization, RpcServer } = await modules.effect('unstable/rpc');
  const C = await modules.source('packages/contracts/src/index.ts');
  const { makeRubatoMobilePresentation, rubatoModelMark } = await modules.source('apps/server/src/provider/RubatoMobilePresentation.ts');
  const { withRubatoMobilePresentation } = await modules.source('apps/server/src/provider/RubatoMobileProtocol.ts');
  const { buildModelOptions, resolveSelectableModelSelection, isModelSelectionUnavailable } =
    await modules.source('apps/mobile/src/lib/modelOptions.ts');
  const { resolveThreadProviderInstance } = await modules.source('apps/mobile/src/features/threads/thread-provider-instance.ts');
  const { applyShellStreamEvent } = await modules.source('packages/client-runtime/src/state/shellReducer.ts');
  const { createEmptyReadModel, projectEvent } = await modules.source('apps/server/src/orchestration/projector.ts');
  const { decideOrchestrationCommand } = await modules.source('apps/server/src/orchestration/decider.ts');
  const Crypto = await modules.effect('Crypto');
  const { randomBytes, createHash } = await import('node:crypto');
  const crypto = Crypto.make({ randomBytes: n => randomBytes(n),
    digest: (algorithm, data) => Effect.succeed(createHash(algorithm.replace('-', '').toLowerCase()).update(data).digest()) });
  const decode = name => value => {
    try { return Schema.decodeUnknownSync(C[name])(value); }
    catch (error) { throw new Error(`${name}: ${error.message ?? String(error)}`); }
  };
  const W = C.WS_METHODS, O = C.ORCHESTRATION_WS_METHODS;
  const stamp = '2026-09-22T00:00:00.000Z';
  const slugs = [
    'anthropic/claude-opus-5', 'cursor/claude-opus-5', 'xai/grok-4.7', 'openai-codex/gpt-6-astra',
    'cursor/composer-2.5', 'google-antigravity/gemini-3.8-flash', 'opencode/muse-spark-1.3',
    'b-ai/deepseek-v4.1-flash', 'google/gemini-3.8-flash', 'moonshot/kimi-k3',
    'alibaba/qwen-3', 'zai/glm-5', 'custom/unknown-model',
  ];
  const provider = decode('ServerProvider')({
    instanceId: 'rubato-test', driver: 'rubato-pi', displayName: 'Rubato', enabled: true,
    installed: true, version: null, status: 'ready', auth: { status: 'unknown' }, checkedAt: stamp,
    models: slugs.map(slug => ({ slug, name: slug.split('/')[1], shortName: slug.split('/')[1],
      isDefault: slug === slugs[0], isCustom: false, capabilities: null })),
    slashCommands: [{ name: 'context-status' }], skills: [],
    workspaceSnapshots: [{ cwd: '/workspace', checkedAt: stamp, slashCommands: [{ name: 'audit' }], skills: [] }],
    requiresNewThreadForModelChange: false, setup: { canAuthenticate: false, canInstall: false },
  });
  const native = decode('ServerProvider')({ ...provider, instanceId: 'native-claude', driver: 'claudeAgent' });
  let providers = [provider, native];
  let settings = { ...C.DEFAULT_SERVER_SETTINGS,
    defaultModelSelection: { instanceId: provider.instanceId, model: slugs[0] } };
  const config = () => ({
    environment: { environmentId: 'test-env', label: 'Test', platform: { os: 'darwin', arch: 'arm64' },
      serverVersion: '0.0.0-test', capabilities: { repositoryIdentity: true, connectionProbe: true } },
    auth: { policy: 'loopback-browser', bootstrapMethods: ['one-time-token'],
      sessionMethods: ['browser-session-cookie'], sessionCookieName: 't3_session' },
    cwd: '/workspace', keybindingsConfigPath: '/workspace/keys.json', keybindings: [], issues: [],
    providers, availableEditors: [], settings,
    observability: { logsDirectoryPath: '/tmp/logs', localTracingEnabled: false,
      otlpTracesEnabled: false, otlpMetricsEnabled: false },
  });
  const original = structuredClone(providers);
  const view = makeRubatoMobilePresentation(providers);
  const selection = slug => view.selection({ instanceId: provider.instanceId, model: slug });

  await t.test('safe native glyphs are selected and other groups add emoji to names only', () => {
    const presented = decode('ServerConfig')(view.config(Schema.encodeSync(C.ServerConfig)(config())));
    const options = buildModelOptions(presented, null);
    const option = slug => options.find(row => row.selection.model === slug && row.selection.instanceId !== native.instanceId);
    for (const [slug, driver, emoji] of [
      [slugs[0], 'claudeAgent', ''], [slugs[1], 'claudeAgent', ''], [slugs[2], 'grok', ''],
      [slugs[3], 'rubato-pi', ''], [slugs[4], 'cursor', ''], [slugs[5], 'rubato-pi', '🪐'],
      [slugs[6], 'opencode', ''], [slugs[7], 'rubato-pi', '🐋'],
      [slugs[8], 'rubato-pi', '✨'], [slugs[9], 'rubato-pi', '🌙'],
      [slugs[10], 'rubato-pi', '🐼'], [slugs[11], 'rubato-pi', '💎'], [slugs[12], 'rubato-pi', '🤖'],
    ]) {
      assert.equal(option(slug).providerDriver, driver, slug);
      assert.ok(option(slug).label.startsWith(emoji), slug);
      assert.equal(view.selection(option(slug).selection, true).instanceId, provider.instanceId);
      assert.equal(view.selection(option(slug).selection, true).model, slug);
    }
    assert.deepEqual(presented.providers.find(row => row.instanceId === native.instanceId), native);
    assert.deepEqual(providers, original);
    // Old local mobile drafts must fall back instead of creating duplicate,
    // generic OpenAI rows next to the new display groups.
    assert.equal(resolveSelectableModelSelection(presented, settings.defaultModelSelection), null);
    for (const row of presented.providers) assert.deepEqual(row.workspaceSnapshots, provider.workspaceSnapshots);
    assert.equal(rubatoModelMark('opencode/anthropic/claude-opus-5'), 'claude');
    assert.equal(rubatoModelMark('openai/o3'), 'openai');
  });

  await t.test('display groups never enable Codex feedback interception or Antigravity send gates', () => {
    const presented = view.config(config());
    const rubatoGroups = presented.providers.filter(row => row.instanceId !== native.instanceId);
    // The stock composer consumes /feedback for driver=codex. Unknown drivers
    // already render the same OpenAI glyph, so none should impersonate Codex.
    assert.equal(rubatoGroups.some(row => row.driver === 'codex'), false);
    for (const status of [
      {}, { enabled: false }, { installed: false },
      { auth: { status: 'unauthenticated' } }, { availability: 'unavailable' },
      { models: [...provider.models.filter(model => model.slug !== slugs[5]),
        { ...provider.models[5], slug: 'google-antigravity/gemini-alternative' }] },
    ]) {
      const canonicalConfig = { ...config(), providers: [{ ...provider, ...status }] };
      const mobileConfig = makeRubatoMobilePresentation(canonicalConfig.providers).config(canonicalConfig);
      const originalSelection = { instanceId: provider.instanceId, model: slugs[5] };
      const mobileSelection = selection(slugs[5]);
      assert.equal(isModelSelectionUnavailable(mobileConfig, mobileSelection),
        isModelSelectionUnavailable(canonicalConfig, originalSelection));
      assert.equal(resolveSelectableModelSelection(mobileConfig, mobileSelection) !== null,
        resolveSelectableModelSelection(canonicalConfig, originalSelection) !== null);
    }
  });

  let readModel = createEmptyReadModel(stamp);
  let sequence = 0;
  let events = [];
  const dispatches = [];
  const refreshes = [];
  let threadReads = 0;
  const dispatch = command => Effect.gen(function* () {
    dispatches.push(command);
    const decided = yield* decideOrchestrationCommand({ command, readModel });
    events = [];
    for (const event of Array.isArray(decided) ? decided : [decided]) {
      const sequenced = { ...event, sequence: ++sequence };
      readModel = yield* projectEvent(readModel, sequenced);
      events.push(sequenced);
    }
    return { sequence };
  });
  const getThread = () => readModel.threads[0];
  const shell = () => decode('OrchestrationShellSnapshot')({
    snapshotSequence: sequence, updatedAt: stamp, projects: readModel.projects,
    threads: readModel.threads.map(thread => ({ ...thread, latestUserMessageAt: null,
      hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false })),
  });
  const handlers = {
    [W.serverGetConfig]: () => Effect.sync(config),
    [W.serverRefreshProviders]: input => Effect.sync(() => { refreshes.push(input); return { providers }; }),
    [W.serverGetSettings]: () => Effect.sync(() => settings),
    [W.serverUpdateSettings]: input => Effect.sync(() => {
      settings = { ...settings, ...input.patch }; return settings;
    }),
    [W.subscribeServerConfig]: () => Stream.fromIterable([
      { version: 1, type: 'snapshot', config: config() },
      { version: 1, type: 'providerStatuses', payload: { providers } },
      { version: 1, type: 'settingsUpdated', payload: { settings } },
    ]),
    [O.dispatchCommand]: dispatch,
    [O.subscribeShell]: () => Stream.fromIterable([
      { kind: 'snapshot', snapshot: { ...shell(), snapshotSequence: sequence - 1 } },
      { kind: 'thread-upserted', sequence, thread: shell().threads[0] },
      { kind: 'synchronized' },
    ]),
    [O.getArchivedShellSnapshot]: () => Effect.sync(shell),
    [O.subscribeThread]: () => Stream.fromIterable([
      { kind: 'snapshot', snapshot: { snapshotSequence: sequence, thread: getThread() } },
      ...events.map(event => ({ kind: 'event', event })),
    ]),
  };
  const group = RpcGroup.make(...Object.keys(handlers).map(method => C.WsRpcGroup.requests.get(method)));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const responses = yield* Queue.unbounded();
    const receive = yield* Deferred.make();
    const protocol = yield* RpcServer.Protocol.make(write => Effect.gen(function* () {
      yield* Deferred.succeed(receive, write);
      const serialization = yield* RpcSerialization.RpcSerialization;
      return {
        disconnects: yield* Queue.unbounded(),
        send: (_clientId, response) => Queue.offer(responses, structuredClone(response)),
        end: () => Effect.void, clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone, supportsAck: true, supportsTransferables: false,
        supportsSpanPropagation: false, supportsNotifications: true, codecFor: serialization.codecFor,
      };
    }));
    const opts = { providers: Effect.sync(() => providers), thread: () => Effect.sync(() => {
      threadReads++; return getThread();
    }) };
    for (const surface of ['web', 'desktop', undefined]) {
      assert.equal(withRubatoMobilePresentation(protocol, { ...opts, surface }), protocol);
    }
    yield* RpcServer.make(group).pipe(
      Effect.provide(group.toLayer(handlers)),
      Effect.provideService(RpcServer.Protocol, withRubatoMobilePresentation(protocol, { ...opts, surface: 'mobile' })),
      Effect.forkScoped,
    );
    const write = yield* Deferred.await(receive);
    let requestId = 0;
    const invoke = (tag, payload, expectFailure = false) => Effect.gen(function* () {
      const id = String(++requestId);
      yield* write(0, { _tag: 'Request', id, tag, payload: structuredClone(payload), headers: [] });
      const chunks = [];
      while (true) {
        const response = yield* Queue.take(responses);
        assert.equal(response.requestId, id);
        if (response._tag === 'Chunk') {
          chunks.push(...response.values);
          yield* write(0, { _tag: 'Ack', requestId: id });
        } else {
          assert.equal(response._tag, 'Exit');
          assert.equal(response.exit._tag, expectFailure ? 'Failure' : 'Success', JSON.stringify(response.exit));
          return chunks.length ? chunks : response.exit.value;
        }
      }
    });
    const mobileConfig = yield* invoke(W.serverGetConfig, {});
    decode('ServerConfig')(mobileConfig);
    assert.equal(mobileConfig.settings.defaultModelSelection.instanceId, selection(slugs[0]).instanceId);
    const configEvents = yield* invoke(W.subscribeServerConfig, {});
    for (const event of configEvents) decode('ServerConfigStreamEvent')(event);
    assert.deepEqual(configEvents[1].payload.providers, mobileConfig.providers);
    const refreshed = yield* invoke(W.serverRefreshProviders, {
      instanceId: selection(slugs[0]).instanceId, cwd: '/workspace', refreshModels: true,
    });
    assert.equal(refreshes[0].instanceId, provider.instanceId);
    assert.deepEqual(refreshed.providers, mobileConfig.providers);
    yield* Effect.promise(() => t.test('config snapshot/stream and targeted workspace refresh pass through real RPC codecs', () => {}));

    yield* invoke(O.dispatchCommand, { type: 'project.create', commandId: 'project-command',
      projectId: 'project-1', title: 'Project', workspaceRoot: '/workspace', createdAt: stamp });
    yield* invoke(O.dispatchCommand, { type: 'thread.create', commandId: 'thread-command',
      threadId: 'thread-1', projectId: 'project-1', title: 'Conversation', modelSelection: selection(slugs[0]),
      runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null, createdAt: stamp });
    const session = { threadId: 'thread-1', status: 'ready', providerName: 'rubato-pi',
      providerInstanceId: provider.instanceId, runtimeMode: 'full-access', activeTurnId: null,
      lastError: null, updatedAt: stamp };
    yield* dispatch(decode('OrchestrationCommand')({ type: 'thread.session.set',
      commandId: 'session-command', threadId: 'thread-1', session, createdAt: stamp }));
    const detail = yield* invoke(O.subscribeThread, { threadId: 'thread-1' });
    for (const item of detail) decode('OrchestrationThreadStreamItem')(item);
    assert.equal(detail[0].snapshot.thread.session.providerInstanceId, selection(slugs[0]).instanceId);
    assert.equal(detail[1].event.payload.session.providerInstanceId, selection(slugs[0]).instanceId);
    assert.equal(threadReads, 1);
    yield* invoke(O.dispatchCommand, { type: 'thread.meta.update', commandId: 'switch-command',
      threadId: 'thread-1', modelSelection: selection(slugs[2]) });
    assert.equal(getThread().modelSelection.instanceId, provider.instanceId);
    assert.equal(getThread().modelSelection.model, slugs[2]);
    const stream = yield* invoke(O.subscribeShell, {});
    for (const item of stream) decode('OrchestrationShellStreamItem')(item);
    const liveShell = applyShellStreamEvent(stream[0].snapshot, stream[1]);
    const row = resolveThreadProviderInstance(new Map([['test-env', mobileConfig]]),
      { ...liveShell.threads[0], environmentId: 'test-env' });
    assert.equal(row.driverKind, 'grok');
    assert.equal(liveShell.threads[0].session.providerInstanceId, selection(slugs[2]).instanceId);
    const archived = yield* invoke(O.getArchivedShellSnapshot, {});
    assert.equal(archived.threads[0].modelSelection.instanceId, selection(slugs[2]).instanceId);
    const afterSwitch = yield* invoke(O.subscribeThread, { threadId: 'thread-1' });
    assert.equal(afterSwitch[1].event.payload.modelSelection.instanceId, selection(slugs[2]).instanceId);
    assert.equal(threadReads, 1, 'non-session detail events must not query the database');
    yield* Effect.promise(() => t.test('real command decider/projector stays canonical while mobile shell/detail/sidebar get marks', () => {}));

    const options = [{ id: 'reasoningEffort', value: 'high' }];
    yield* invoke(W.serverUpdateSettings, { patch: { defaultModelSelection: { ...selection(slugs[1]), options } } });
    assert.equal(settings.defaultModelSelection.instanceId, provider.instanceId);
    assert.equal(settings.defaultModelSelection.model, slugs[1]);
    assert.deepEqual(settings.defaultModelSelection.options, options);
    const persistedSettings = yield* invoke(W.serverGetSettings, {});
    assert.equal(persistedSettings.defaultModelSelection.instanceId, selection(slugs[1]).instanceId);
    yield* invoke(W.serverUpdateSettings, { patch: {
      textGenerationModelSelection: selection(slugs[0]),
      sourceControlWriterModelSelection: selection(slugs[2]),
      projectSettingsOverrides: { 'project-1': {
        defaultModelSelection: selection(slugs[7]),
        textGenerationModelSelection: selection(slugs[0]),
        sourceControlWriterModelSelection: selection(slugs[2]),
      } },
    } });
    for (const key of ['textGenerationModelSelection', 'sourceControlWriterModelSelection']) {
      assert.equal(settings[key].instanceId, provider.instanceId);
    }
    for (const value of Object.values(settings.projectSettingsOverrides['project-1'])) {
      assert.equal(value.instanceId, provider.instanceId);
    }
    const projectDefaults = yield* invoke(W.serverGetSettings, {});
    assert.equal(projectDefaults.projectSettingsOverrides['project-1'].defaultModelSelection.instanceId,
      selection(slugs[7]).instanceId);
    const before = dispatches.length;
    yield* invoke(O.dispatchCommand, { type: 'thread.meta.update', commandId: 'invalid-command',
      threadId: 'thread-1', modelSelection: { ...selection(slugs[0]), model: slugs[2] } }, true);
    assert.equal(dispatches.length, before);
    yield* invoke(W.serverUpdateSettings, { patch: {
      providerInstances: { [selection(slugs[0]).instanceId]: { driver: 'claudeAgent', enabled: true, config: {} } },
    } }, true);
    providers = [native];
    yield* invoke(W.serverUpdateSettings, { patch: { defaultModelSelection: selection(slugs[0]) } }, true);
    providers = [provider, native];
    const finalConfig = yield* invoke(W.serverGetConfig, {});
    assert.equal(finalConfig.providers.some(row => row.driver === 'claudeAgent'), true);
    assert.equal(getThread().session.providerInstanceId, provider.instanceId);
    yield* Effect.promise(() => t.test('settings are canonical; stale or mismatched aliases fail only that RPC before mutation', () => {}));
  })).pipe(Effect.provide(RpcSerialization.layerJson), Effect.provideService(Crypto.Crypto, crypto)));
});
