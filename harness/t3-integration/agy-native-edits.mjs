// Rewind and fork on agy's own conversation store (agy-native.mjs, RubatoAgyNative.ts,
// RubatoAgyNativeRollback.ts).
//
// Upstream ACP rollback starts a fresh agent session and replays the kept turns as a handoff, and
// ACP fork needs `session/fork`, which agy lacks. Through Rubato's approval bridge agy answers
// both natively: the bridge advertises `session/fork` and `_meta.rubato.nativeRewind`, and a
// flavor's `nativeRollback` then
// - rolls back in place: the adapter leaves a cut through the end of the last kept turn, keeps
//   the native session, and reports `providerCanRollbackConversation`, so the next turn sends no
//   replayed history;
// - forks from an earlier turn by that turn's end time, since agy turns carry no native id.
// Agents without the bridge keep upstream behavior.
const adapter = 'packages/provider-acp/src/server/adapter.ts';
const adapterTest = 'apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts';
const antigravity = 'apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts';

export const agyNativeOverlays = [
  'apps/server/src/provider/RubatoAgyNative.ts',
  'apps/server/src/provider/RubatoAgyNativeRollback.ts',
  'apps/server/src/provider/RubatoAgyNative.test.ts',
];

export const agyNativeEdits = {
  [adapter]: [
    [
      `  /**
   * Compacts with the agent's own request, for agents that answer a \`/compact\` prompt as chat.`,
      `  /**
   * Rubato: the agent rolls its own conversation back in place (agy through Rubato's bridge), so
   * a rollback keeps the native session and the next turn replays no history. \`supported\` reads
   * the agent's \`initialize\` answer; \`cut\` keeps the session through \`keepThroughTime\`, the end
   * of the last turn that stays; \`forkMeta\` asks \`session/fork\` to copy only that far.
   */
  readonly nativeRollback?: {
    readonly supported: (
      initializeResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["initializeResult"],
    ) => boolean;
    readonly cut: (input: {
      readonly sessionId: string;
      readonly keepThroughTime: string;
    }) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly forkMeta: (
      keepThroughTime: string,
    ) => NonNullable<EffectAcpSchema.ForkSessionRequest["_meta"]>;
  };
`,
    ],
    [
      '  readonly flavor: Pick<AcpAdapterV2Flavor, "forkFromTurn">;\n',
      '  readonly flavor: Pick<AcpAdapterV2Flavor, "forkFromTurn" | "nativeRollback">;\n',
      'replace',
    ],
    [
      '  const ref = target.nativeTurnRef;\n',
      `  // Rubato: an agent that cuts its own conversation forks through the end of that turn.
  if (input.flavor.nativeRollback !== undefined && input.canForkFromTurn) {
    return target.completedAt === null
      ? null
      : input.flavor.nativeRollback.forkMeta(DateTime.formatIso(target.completedAt));
  }
`,
    ],
    [
      `        const capabilities = negotiatedCapabilities(
          yield* readCapabilities,
          started,
          flavor.modelOptionArrivesLate === true,
          flavor.forkFromTurn?.supported(started.initializeResult) === true,
          steersWithPrompt,
        );
`,
      `        // Rubato: an agent that rolls back natively also forks from a turn, by its end time.
        const rollsBackNatively =
          flavor.nativeRollback?.supported(started.initializeResult) === true;
        const negotiated = negotiatedCapabilities(
          yield* readCapabilities,
          started,
          flavor.modelOptionArrivesLate === true,
          flavor.forkFromTurn?.supported(started.initializeResult) === true || rollsBackNatively,
          steersWithPrompt,
        );
        const capabilities = rollsBackNatively
          ? {
              ...negotiated,
              checkpointing: {
                ...negotiated.checkpointing,
                providerCanRollbackConversation: true,
              },
            }
          : negotiated;
`,
      'replace',
    ],
    [
      `                  yield* awaitRuntimeTeardown();
                  itemIdentityVersion = 2;
                  prepareTerminalEnvironment(
                    yield* readMcpContext(rollbackInput.providerThread.appThreadId),
                  );`,
      `                  // Rubato: keep the native session and cut it through the last kept turn.
                  const nativeSessionId = rollbackInput.providerThread.nativeThreadRef?.nativeId;
                  const keptTurn =
                    rollbackInput.target.type === "provider_turn"
                      ? rollbackInput.target.providerTurn
                      : undefined;
                  if (
                    flavor.nativeRollback !== undefined &&
                    capabilities.checkpointing.providerCanRollbackConversation &&
                    typeof nativeSessionId === "string" &&
                    keptTurn !== undefined &&
                    keptTurn.providerThreadId === rollbackInput.providerThread.id &&
                    keptTurn.completedAt !== null
                  ) {
                    yield* flavor.nativeRollback.cut({
                      sessionId: nativeSessionId,
                      keepThroughTime: DateTime.formatIso(keptTurn.completedAt),
                    });
                    const cutAt = yield* DateTime.now;
                    return {
                      providerThread: {
                        ...rollbackInput.providerThread,
                        status: "idle" as const,
                        lastRunOrdinal: rollbackInput.target.appRunOrdinal,
                        updatedAt: cutAt,
                      },
                      providerTurns: [],
                      messages: [],
                      runtimeRequests: [],
                    };
                  }
`,
    ],
  ],
  [antigravity]: [
    [
      'import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";\n',
      'import { rubatoAgyNativeRollback } from "../../provider/RubatoAgyNativeRollback.ts";\n',
    ],
    [
      '    makeRuntime,\n    buildAttachmentPrompt:',
      '    // Rubato: agy rewinds and forks its own conversation through the approval bridge.\n    nativeRollback: rubatoAgyNativeRollback,\n',
    ],
  ],
  // Beside upstream's rollback tests, on the same mock agent: a flavor that rolls back natively
  // keeps its session, leaves the cut, and starts no replacement runtime.
  [adapterTest]: [
    [
      '  it.effect("quarantines callbacks from a failed rollback replacement before retrying", () =>\n',
      `  it.effect("keeps the ACP session and leaves a cut when the agent rolls back natively", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const instanceId = ProviderInstanceId.make("acp-test-native-rollback");
      const cuts: Array<{ readonly sessionId: string; readonly keepThroughTime: string }> = [];
      let runtimesStarted = 0;
      const makeRuntime = makeMockRuntime({ childProcessSpawner, mockAgentPath });
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => {
              runtimesStarted += 1;
            }).pipe(Effect.andThen(makeRuntime(runtimeInput))),
          nativeRollback: {
            supported: () => true,
            cut: (input) =>
              Effect.sync(() => {
                cuts.push(input);
              }),
            forkMeta: (keepThroughTime) => ({ rubato: { keepThroughTime } }),
          },
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-native-rollback");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-native-rollback"),
        modelSelection,
        runtimePolicy,
      });
      // The next turn after a native rollback carries no replayed history.
      assert.isTrue(runtime.providerSession.capabilities.checkpointing.providerCanRollbackConversation);
      const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      const sessionId = providerThread.nativeThreadRef?.nativeId;
      const completedAt = yield* DateTime.now;
      const keptTurn = {
        id: "provider-turn-native-rollback-kept",
        providerThreadId: providerThread.id,
        ordinal: 1,
        completedAt,
      } as never;
      const rolledBack = yield* runtime.rollbackThread({
        providerThread,
        providerThreadTurns: [keptTurn],
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-acp-native-rollback"),
          appRunOrdinal: 1,
          providerTurn: keptTurn,
        },
      });
      assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, sessionId);
      assert.equal(rolledBack.providerThread.lastRunOrdinal, 1);
      assert.deepEqual(cuts, [{ sessionId, keepThroughTime: DateTime.formatIso(completedAt) }]);
      assert.equal(runtimesStarted, 1);

      // Rolling back to the thread's start keeps upstream's fresh session: nothing is kept.
      const restarted = yield* runtime.rollbackThread({
        providerThread: rolledBack.providerThread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-native-rollback-start"),
          appRunOrdinal: 0,
        },
      });
      assert.isString(restarted.providerThread.nativeThreadRef?.nativeId);
      assert.equal(runtimesStarted, 2);
      assert.equal(cuts.length, 1);
    }).pipe(Effect.provide(layerTest)),
  );

`,
    ],
  ],
};
