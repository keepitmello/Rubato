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

export const handoffRecoveryEdits = {
  'apps/server/src/orchestration-v2/ProviderTurnStartService.ts': [
    [KEPT_NATIVE_ANCHOR, KEPT_NATIVE, 'replace'],
  ],
  'apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts': [
    [FAIL_INJECTION_FIELD, INJECTS_HISTORY_FIELD, 'replace'],
    [ACK_ANCHOR, ACK_HONOURS_INJECTS_HISTORY, 'replace'],
    [NATIVE_LEGACY_ANCHOR, KEPT_NATIVE_TEST],
  ],
};
