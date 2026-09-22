  it.effect("Rubato marks reach authenticated mobile sockets but not simultaneous web sockets", () =>
    Effect.gen(function* () {
      const provider = Schema.decodeUnknownSync(RubatoTestProviderSchema)({
        instanceId: "rubato-network", driver: "rubato-pi", displayName: "Rubato",
        enabled: true, installed: true, version: null, status: "ready",
        auth: { status: "unknown" }, checkedAt: "2026-09-22T00:00:00.000Z",
        models: [
          { slug: "anthropic/claude-opus-5", name: "Claude Opus 5", isCustom: false, capabilities: null },
          { slug: "xai/grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null },
          { slug: "b-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", isCustom: false, capabilities: null },
        ],
      });
      const canonicalSelection = { instanceId: provider.instanceId, model: provider.models[0]!.slug };
      const model = makeDefaultOrchestrationReadModel();
      model.threads[0]!.modelSelection = canonicalSelection;
      const shellThread = makeDefaultOrchestrationThreadShell({
        modelSelection: canonicalSelection,
        session: {
          threadId: defaultThreadId, status: "ready", providerName: "rubato-pi",
          providerInstanceId: provider.instanceId, runtimeMode: "full-access",
          activeTurnId: null, lastError: null, updatedAt: "2026-09-22T00:00:00.000Z",
        },
      });
      const received: unknown[] = [];
      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([provider]),
            refreshInstance: () => Effect.succeed([provider]),
          },
          orchestrationEngine: {
            dispatch: command => Effect.sync(() => { received.push(command); return { sequence: 1 }; }),
          },
          projectionSnapshotQuery: {
            getCommandReadModel: () => Effect.succeed(model),
            getShellSnapshot: () => Effect.succeed({
              snapshotSequence: 1, projects: [], threads: [shellThread],
              updatedAt: "2026-09-22T00:00:00.000Z",
            }),
          },
        },
      });
      const mobileUrl = yield* getWsServerUrl("/ws?clientSurface=mobile&clientDeviceType=phone&clientOs=iOS");
      const webUrl = yield* getWsServerUrl("/ws?clientSurface=web");
      let alias: string | undefined;
      yield* Effect.scoped(withWsRpcClient(webUrl, web =>
        withWsRpcClient(mobileUrl, mobile => Effect.gen(function* () {
          const webConfig = yield* web[WS_METHODS.serverGetConfig]({});
          const mobileConfig = yield* mobile[WS_METHODS.serverGetConfig]({});
          assert.deepEqual(webConfig.providers, [provider]);
          const claude = mobileConfig.providers.find(value => value.driver === "claudeAgent")!;
          const grok = mobileConfig.providers.find(value => value.driver === "grok")!;
          const deepseek = mobileConfig.providers.find(value => value.models[0]?.slug.startsWith("b-ai/"))!;
          alias = claude.instanceId;
          assert.notEqual(alias, provider.instanceId);
          assert.equal(claude.models[0]!.slug, provider.models[0]!.slug);
          assert.equal(deepseek.models[0]!.name, "🐋 DeepSeek V4.1 Flash");
          yield* mobile[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.meta.update", commandId: CommandId.make("mobile-model-change"),
            threadId: defaultThreadId, modelSelection: { instanceId: grok.instanceId, model: grok.models[0]!.slug },
          });
          assert.deepEqual((received[0] as { modelSelection: unknown }).modelSelection, {
            instanceId: provider.instanceId, model: "xai/grok-4.7",
          });
          const configItem = yield* Stream.runHead(mobile[WS_METHODS.subscribeServerConfig]({}));
          assert.isTrue(Option.isSome(configItem));
          if (Option.isSome(configItem) && configItem.value.type === "snapshot") {
            assert.deepEqual(configItem.value.config.providers, mobileConfig.providers);
          }
          const item = yield* Stream.runHead(mobile[ORCHESTRATION_WS_METHODS.subscribeShell]({}));
          assert.isTrue(Option.isSome(item));
          if (Option.isSome(item) && item.value.kind === "snapshot") {
            assert.equal(item.value.snapshot.threads[0]!.modelSelection.instanceId, alias);
            assert.equal(item.value.snapshot.threads[0]!.session?.providerInstanceId, alias);
          }
          assert.deepEqual((yield* web[WS_METHODS.serverGetConfig]({})).providers, [provider]);
        })),
      ));
      yield* Effect.scoped(withWsRpcClient(mobileUrl, mobile => Effect.gen(function* () {
        const config = yield* mobile[WS_METHODS.serverGetConfig]({});
        assert.equal(config.providers.find(value => value.driver === "claudeAgent")!.instanceId, alias);
      })));
      assert.equal(model.threads[0]!.modelSelection.instanceId, provider.instanceId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
