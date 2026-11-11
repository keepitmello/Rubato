// When a provider keeps its own thread through the uncertain-delivery fallback, re-deliver
// the pending context handoffs instead of failing every turn.
//
// Upstream's recovery for an ambiguous `pending` handoff marker is "move to a fresh native
// thread": ProviderTurnStartService skips the resume, calls ensureThread with the native ref
// dropped, and lets the guard in ContextHandoffDelivery see a different native id. Rubato
// rebinds a thread to its engine session, so the same id comes back and that recovery is
// inert: the guard fires on every turn and no marker is ever cleared. Rubato's injectHistory
// is a "is this history already native?" check, so its markers only ever mean "inline text
// went with a prompt that may not have arrived" — re-delivering them is the same trade-off
// upstream already takes for text-only providers, and far cheaper than the full-thread
// summary, which would replay the whole conversation into the session that already holds it.
const KEPT_NATIVE_ANCHOR = `        if (replacement === undefined) return undefined;
`;

const KEPT_NATIVE = `        if (replacement === undefined) return undefined;
        // Rubato (handoff-recovery-edits.mjs): a provider whose thread is its own
        // conversation (Rubato rebinds the thread to its engine session) returns the
        // same native thread. Nothing was replaced, so its history is still there and
        // a full-thread summary would replay it. The uncertain markers are prompts it
        // may never have read: deliver them again, as unsent, instead of failing every
        // turn on them.
        const keptNativeId = providerThread.nativeThreadRef?.nativeId;
        if (
          uncertainDelivery &&
          keptNativeId != null &&
          replacement.nativeThreadRef?.nativeId === keptNativeId
        ) {
          yield* Effect.logWarning(
            "Provider kept its native thread; re-delivering uncertain context handoffs",
            { driver: session.driver, providerThreadId: providerThread.id, runId },
          );
          effectiveHandoffs = effectiveHandoffs.map((handoff) => {
            if (
              handoff.delivery?.nativeThreadId !== keptNativeId ||
              handoff.delivery.status !== "pending"
            )
              return handoff;
            const { delivery: _uncertain, ...unsent } = handoff;
            return unsent;
          });
          return replacement;
        }
`;

const FAIL_INJECTION_FIELD = `  readonly failInjectionOnce?: Ref.Ref<boolean>;
`;

const INJECTS_HISTORY_FIELD = `  readonly failInjectionOnce?: Ref.Ref<boolean>;
  /** What injectHistory answers once it recorded the history: false leaves it inline (Rubato). */
  readonly injectsHistory?: boolean;
`;

const ACK_ANCHOR = `                            "lost injection acknowledgement",
                          );
                        return true;
`;

const ACK_HONOURS_INJECTS_HISTORY = `                            "lost injection acknowledgement",
                          );
                        return input.injectsHistory ?? true;
`;

const NATIVE_LEGACY_ANCHOR = `  it.live.each(["native", "legacy"] as const)(
`;

const KEPT_NATIVE_TEST = `  // Rubato (handoff-recovery-edits.mjs): the fresh-thread fallback returns the same native thread.
  it.live.each(["inline", "injection"] as const)(
    "re-delivers an uncertain %s handoff once when the provider keeps its native thread",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(\`handoff-kept-native-\${failure}\`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const failOnce = yield* Ref.make(true);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: { 1: "Original partial work" },
              capturedTurns,
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              injectedHistory,
              getModelContextWindow: () => 32_000,
              ...(failure === "inline"
                ? { injectsHistory: false, failStartOnce: failOnce }
                : { failInjectionOnce: failOnce }),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(\`kept:\${ordinal}\`),
                threadId,
                messageId: MessageId.make(\`kept:\${ordinal}\`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
              });
            const wait = (ordinal: number, status: "failed" | "completed") =>
              orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
                Effect.andThen(worker.drain()),
                Effect.andThen(
                  Effect.gen(function* () {
                    assert.equal(
                      (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                      status,
                    );
                  }),
                ),
              );
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("kept:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Kept native thread",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
            yield* wait(1, "completed");
            yield* dispatch(2, "First target request", CLAUDE_MODEL_SELECTION);
            yield* wait(2, "failed");
            const failedHandoff = (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.at(-1)!;
            assert.equal(failedHandoff.delivery?.status, "pending");
            const historyBeforeRetry = (yield* Ref.get(injectedHistory)).length;
            yield* dispatch(3, "Retry target request", CLAUDE_MODEL_SELECTION);
            yield* wait(3, "completed");
            const retried = yield* orchestrator.getThreadProjection(threadId);
            const retryRun = retried.runs.find((run) => run.ordinal === 3)!;
            assert.equal(
              retried.providerThreads.find((thread) => thread.id === retryRun.providerThreadId)
                ?.nativeThreadRef?.nativeId,
              failedHandoff.delivery!.nativeThreadId,
            );
            assert.notInclude(
              retried.contextHandoffs
                .filter((handoff) => handoff.targetRunId === retryRun.id)
                .map((handoff) => handoff.strategy),
              "full_thread_summary",
            );
            assert.isFalse(retried.contextHandoffs.some((handoff) => handoff.delivery?.status === "pending"));
            const retriedHandoff = retried.contextHandoffs.find((handoff) => handoff.id === failedHandoff.id)!;
            const lastTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
            if (failure === "inline") {
              assert.equal(lastTurn.text.split("Original request with constraints").length - 1, 1);
              assert.include(lastTurn.text, "First target request");
              assert.isTrue(lastTurn.text.endsWith("User message:\\nRetry target request"));
              assert.equal(retriedHandoff.delivery?.status, "inline");
            } else {
              assert.equal(lastTurn.text, "Retry target request");
              assert.include(
                yield* encodeJson((yield* Ref.get(injectedHistory)).slice(historyBeforeRetry)),
                "Original request with constraints",
              );
              assert.equal(retriedHandoff.delivery?.status, "injected");
            }
            const historyBeforeFollowup = yield* Ref.get(injectedHistory);
            yield* dispatch(4, "Follow-up request", CLAUDE_MODEL_SELECTION);
            yield* wait(4, "completed");
            assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, "Follow-up request");
            assert.deepEqual(yield* Ref.get(injectedHistory), historyBeforeFollowup);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.length,
              retried.contextHandoffs.length,
            );
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: \`handoff-kept-native-\${failure}\`,
                  runtimePolicyOverride: { cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

`;

// Without measured usage on the provider thread, upstream charges a returning native thread
// with the UTF-8 bytes of everything the app recorded for it, tool output included. A session
// that compacts or swaps its own context (Rubato's context notes) holds far less: a gpt-6.1-sol
// session at 122k of its 500k window was charged 574k, the budget fell to zero, and every turn
// was refused before it could report the usage that would have cleared it. The session is
// asked first; the byte count stays the fallback for providers that cannot say.
const READ_CONTEXT_TOKENS_FIELD_ANCHOR = `  readonly canReuseContextUsage?: (previous: ModelSelection, next: ModelSelection) => boolean;
`;

const READ_CONTEXT_TOKENS_FIELD = `  readonly canReuseContextUsage?: (previous: ModelSelection, next: ModelSelection) => boolean;
  /**
   * Rubato (handoff-recovery-edits.mjs): tokens the native thread holds now, as the provider
   * counts them. A handoff budget asks this before it counts the app's saved transcript,
   * which overstates a session that compacts or swaps its own context.
   */
  readonly readContextTokens?: Effect.Effect<number | undefined>;
`;

const PI_READ_CONTEXT_TOKENS_ANCHOR = `        ensureThread: (threadInput) =>
`;

const PI_READ_CONTEXT_TOKENS = `        // Rubato (handoff-recovery-edits.mjs): Pi's own count, from the session stats.
        readContextTokens: DateTime.now.pipe(
          Effect.flatMap((now) => readTokenUsage(null, now)),
          Effect.map((usage) => usage?.usedTokens),
        ),
`;

const PI_READ_CONTEXT_TOKENS_TEST_ANCHOR = `  it.effect("budgets legacy native history with Pi's selected model capacity", () =>
`;

const PI_READ_CONTEXT_TOKENS_TEST = `  // Rubato: handoff-recovery-edits.mjs lets a handoff budget ask Pi what the session holds.
  it.effect("reads the session's context tokens from Pi's session stats", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueStats({ contextUsage: { tokens: 122_103, contextWindow: 500_000 } });
      assert.equal(yield* runtime.readContextTokens!, 122_103);
      fake.queueStats({});
      assert.isUndefined(yield* runtime.readContextTokens!);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

`;

const MEASURED_ESTIMATE_ANCHOR = `      const nativeContextEstimate = Effect.gen(function* () {
`;

const MEASURED_ESTIMATE = `      const nativeContextEstimate = Effect.gen(function* () {
        // Rubato (handoff-recovery-edits.mjs): ask the session what its native thread
        // holds before counting this thread's saved text.
        if (sameNativeThread && session.readContextTokens !== undefined) {
          const measured = yield* session.readContextTokens;
          if (measured !== undefined) return measured;
        }
`;

const TEST_ADAPTER_FIELD_ANCHOR = `  readonly getModelContextWindow?: (selection: ModelSelection) => number | undefined;
`;

const TEST_ADAPTER_FIELD = `  readonly getModelContextWindow?: (selection: ModelSelection) => number | undefined;
  readonly readContextTokens?: Effect.Effect<number | undefined>;
`;

const TEST_ADAPTER_RUNTIME_ANCHOR = `          ...(input.canReuseContextUsage === undefined
            ? {}
            : { canReuseContextUsage: input.canReuseContextUsage }),
`;

const TEST_ADAPTER_RUNTIME = `          ...(input.canReuseContextUsage === undefined
            ? {}
            : { canReuseContextUsage: input.canReuseContextUsage }),
          ...(input.readContextTokens === undefined
            ? {}
            : { readContextTokens: input.readContextTokens }),
`;

const MEASURED_RETURN_TEST = `  // Rubato (handoff-recovery-edits.mjs): the target's saved transcript outgrew its window,
  // its session did not.
  it.live.each(["measured", "unmeasured"] as const)(
    "budgets a handoff back to a native thread with %s session context",
    (measurement) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(\`handoff-measured-\${measurement}\`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: { 1: "Original work", 3: "Codex follow-up" },
              capturedTurns,
            }),
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              // Saved text past the window; the session compacted it away.
              responseByRunOrdinal: { 2: "y".repeat(40_000), 4: "Claude resumed" },
              capturedTurns,
              getModelContextWindow: () => 32_000,
              ...(measurement === "measured" ? { readContextTokens: Effect.succeed(4_000) } : {}),
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(\`measured:\${ordinal}\`),
                threadId,
                messageId: MessageId.make(\`measured:\${ordinal}\`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
              });
            const wait = (ordinal: number) =>
              orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
                Effect.andThen(worker.drain()),
                Effect.andThen(orchestrator.getThreadProjection(threadId)),
                Effect.map((projection) => projection.runs.find((run) => run.ordinal === ordinal)!),
              );
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("measured:create"),
              threadId,
              projectId,
              createdBy: "user",
              creationSource: "web",
              title: "Measured return",
              modelSelection: CODEX_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* dispatch(1, "Original request", CODEX_MODEL_SELECTION);
            assert.equal((yield* wait(1)).status, "completed");
            yield* dispatch(2, "Long target work", CLAUDE_MODEL_SELECTION);
            assert.equal((yield* wait(2)).status, "completed");
            yield* dispatch(3, "Back on Codex", CODEX_MODEL_SELECTION);
            assert.equal((yield* wait(3)).status, "completed");
            yield* dispatch(4, "Return to Claude", CLAUDE_MODEL_SELECTION);
            assert.equal(
              (yield* wait(4)).status,
              measurement === "measured" ? "completed" : "failed",
            );
            if (measurement === "measured")
              assert.include((yield* Ref.get(capturedTurns)).at(-1)!.text, "Codex follow-up");
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: \`handoff-measured-\${measurement}\`,
                  runtimePolicyOverride: { cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

`;

export const handoffRecoveryEdits = {
  'packages/provider-core/src/server/ProviderAdapter.ts': [
    [READ_CONTEXT_TOKENS_FIELD_ANCHOR, READ_CONTEXT_TOKENS_FIELD, 'replace'],
  ],
  'packages/provider-pi/src/server/adapter.ts': [
    [PI_READ_CONTEXT_TOKENS_ANCHOR, PI_READ_CONTEXT_TOKENS],
  ],
  'packages/provider-pi/src/server/adapter.test.ts': [
    [PI_READ_CONTEXT_TOKENS_TEST_ANCHOR, PI_READ_CONTEXT_TOKENS_TEST],
  ],
  'apps/server/src/orchestration-v2/ProviderTurnStartService.ts': [
    [KEPT_NATIVE_ANCHOR, KEPT_NATIVE, 'replace'],
    [MEASURED_ESTIMATE_ANCHOR, MEASURED_ESTIMATE, 'replace'],
  ],
  'apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts': [
    [FAIL_INJECTION_FIELD, INJECTS_HISTORY_FIELD, 'replace'],
    [TEST_ADAPTER_FIELD_ANCHOR, TEST_ADAPTER_FIELD, 'replace'],
    [TEST_ADAPTER_RUNTIME_ANCHOR, TEST_ADAPTER_RUNTIME, 'replace'],
    [ACK_ANCHOR, ACK_HONOURS_INJECTS_HISTORY, 'replace'],
    [NATIVE_LEGACY_ANCHOR, KEPT_NATIVE_TEST],
    [NATIVE_LEGACY_ANCHOR, MEASURED_RETURN_TEST],
  ],
};
