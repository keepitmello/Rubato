/**
 * Rewinding to a finished tool step inside a turn (step-rewind-edits.mjs), on T3's V2 orchestrator.
 *
 *   POST /rubato/step-rewind           {threadId, itemId, restoreFiles?}  → {runId, cutAfterItemId, hiddenItemIds, hiddenMessageIds, filesRestored}
 *   POST /rubato/step-rewind/continue  {threadId}          → {}
 *   POST /rubato/step-rewind/batch     {threadId, itemId}  → {cutAfterItemId}
 *
 * `batch` changes nothing: it answers where a rewind to the step would cut, so the web preview
 * fades what the rewind takes. Only the engine knows which calls one model message made.
 *
 * The step is a finished Rubato tool row (its native ref is the Pi tool call). Calls made together
 * answer together, so the cut lands after the whole batch. Later turns go through V2's own rollback
 * (the engine rewinds in place), then the engine lands on the batch's last tool result, the turn's
 * later rows leave the thread (RubatoThreadImporter cutRun) and the turn reads as interrupted. Continue
 * is T3's own resume of an interrupted run; its message reaches the engine as Pi's `continue`, so the
 * model runs on from the tool results with nothing added (rpc-connection.mjs STEP_CONTINUE_TEXT).
 *
 * Nothing changes unless the engine still holds the step. The step's files go back before the
 * engine rewinds (V1's order), so a restore that fails refuses with the conversation unmoved.
 */
import {
  CommandId, MessageId, ThreadId, TurnItemId,
  type OrchestrationV2Run, type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import { piSessionOfThread, rubatoBridge } from "./provider/RubatoPiSessions.ts";
import { RubatoThreadImporter } from "./provider/RubatoThreadImporter.ts";
import { authorized } from "./RubatoServiceRoute.ts";
import { restoreStepCheckpoint } from "./RubatoStepCheckpoints.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";

class StepRewindRefused extends Schema.TaggedError<StepRewindRefused>()("StepRewindRefused", {
  code: Schema.String,
  message: Schema.String,
}) {}
const refuse = (code: string, message: string) => new StepRewindRefused({ code, message });
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const BUSY: ReadonlySet<OrchestrationV2Run["status"]> = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const TEXT_ITEMS: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set(["user_message", "assistant_message", "reasoning"]);
// A tool that ended in an error is a finished step too: its result is what the model saw.
const FINISHED: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set(["completed", "failed"]);

const StepRewindBody = Schema.Struct({ threadId: Schema.String, itemId: Schema.String, restoreFiles: Schema.optional(Schema.Boolean) });
const ContinueBody = Schema.Struct({ threadId: Schema.String });

export const rubatoStepRewindRouteLayer = Layer.unwrap(Effect.gen(function* () {
  const auth = yield* EnvironmentAuth;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const crypto = yield* Crypto.Crypto;
  const services = yield* Effect.context<RubatoThreadImporter | SqlClient.SqlClient | ProviderInstanceRegistry | CheckpointStore.CheckpointStore>();
  const uuid = crypto.randomUUIDv4().pipe(Effect.mapError((cause) => refuse("internal", describe(cause))));
  const commandId = Effect.map(uuid, (id) => CommandId.make(`rubato-step-rewind:${id}`));

  const records = (threadId: ThreadId) =>
    orchestrator.getThreadRecords(threadId, ["runs", "turnItems", "messages", "checkpoints"]).pipe(
      Effect.mapError((cause) => refuse("unknown-thread", describe(cause))));

  // The step, its run, and its batch as the engine holds it.
  const stepOf = (projection: Effect.Success<ReturnType<typeof records>>, threadId: ThreadId, itemId: string, rewinding: boolean) => Effect.gen(function* () {
    const item = projection.turnItems.find((candidate) => candidate.id === itemId);
    const toolCallId = item?.nativeItemRef?.driver === "rubato-pi" ? item.nativeItemRef.nativeId : null;
    if (!item || !toolCallId || TEXT_ITEMS.has(item.type) || !FINISHED.has(item.status) || item.runId === null)
      return yield* refuse("not-a-step", "Only a finished Rubato tool step can be rewound to.");
    if (rewinding && projection.runs.some((run) => BUSY.has(run.status)))
      return yield* refuse("busy", "Wait for this conversation to stop before rewinding.");
    const runId = item.runId;
    const run = projection.runs.find((candidate) => candidate.id === runId);
    if (!run) return yield* refuse("not-a-step", "This step's turn is gone.");
    const session = yield* piSessionOfThread(threadId).pipe(Effect.mapError((cause) => refuse("no-session", describe(cause))));
    if (session === null) return yield* refuse("no-session", "This thread has no Rubato session.");
    const bridge = yield* rubatoBridge(run.providerInstanceId);
    if (bridge === null) return yield* refuse("unavailable", "The Rubato provider is not running.");
    // The engine must still hold the step before anything is undone.
    const batch = yield* Effect.tryPromise({
      try: () => bridge.stepBatch({ threadId, sessionId: session.sessionId, toolCallId }),
      catch: (cause) => refuse("engine-refused", describe(cause)),
    });
    return { item, run, runId, session, bridge, toolCallId, batch };
  });
  /** The run's last row of the step's batch: the rewind lands right after it. */
  const cutAfterOf = (turnItems: ReadonlyArray<OrchestrationV2TurnItem>, runId: string, item: OrchestrationV2TurnItem, batch: ReadonlyArray<string>) => {
    const runItems = turnItems.filter((candidate) => candidate.runId === runId)
      .sort((left, right) => left.ordinal - right.ordinal);
    const batchItems = runItems.filter((candidate) => {
      const nativeId = candidate.nativeItemRef?.nativeId;
      return typeof nativeId === "string" && batch.includes(nativeId) && !TEXT_ITEMS.has(candidate.type);
    });
    return { runItems, cutAfter: batchItems.at(-1) ?? item };
  };

  const preview = (threadId: ThreadId, itemId: string) => Effect.gen(function* () {
    const projection = yield* records(threadId);
    const { item, runId, batch } = yield* stepOf(projection, threadId, itemId, false);
    return { cutAfterItemId: cutAfterOf(projection.turnItems, runId, item, batch).cutAfter.id };
  }).pipe(Effect.provide(services));

  const rewind = (threadId: ThreadId, itemId: string, restoreFiles: boolean) => Effect.gen(function* () {
    let projection = yield* records(threadId);
    const { item, run, runId, session, bridge, toolCallId, batch } = yield* stepOf(projection, threadId, itemId, true);

    // Later turns go the way Edit from here takes them: V2's rollback to this turn's checkpoint.
    // It moves the engine and the thread together, so a refusal after it leaves both at that turn.
    const later = projection.runs.filter((candidate) => candidate.ordinal > run.ordinal && candidate.status !== "rolled_back");
    if (later.length > 0) {
      const checkpoint = projection.checkpoints.find((candidate) => candidate.id === run.checkpointId);
      if (!checkpoint) return yield* refuse("no-checkpoint", "This turn has no checkpoint to rewind to.");
      yield* orchestrator.dispatch({ type: "checkpoint.rollback", commandId: yield* commandId, threadId,
        scopeId: checkpoint.scopeId, checkpointId: checkpoint.id, restoreFiles })
        .pipe(Effect.mapError((cause) => refuse("rollback-failed", describe(cause))));
      for (let attempt = 0; ; attempt++) {
        projection = yield* records(threadId);
        const pending = projection.runs.filter((candidate) => later.some((run) => run.id === candidate.id) && candidate.status !== "rolled_back");
        if (pending.length === 0) break;
        if (attempt >= 150) return yield* refuse("rollback-failed", "The later turns did not roll back.");
        yield* Effect.sleep("200 millis");
      }
    }
    const current = projection.runs.find((candidate) => candidate.id === runId) ?? run;
    const { runItems, cutAfter } = cutAfterOf(projection.turnItems, runId, item, batch);
    // The turn's checkpoint row stays: it is where Edit from here lands for this turn.
    const hiddenItems = runItems.filter((candidate) => candidate.ordinal > cutAfter.ordinal && candidate.type !== "checkpoint");
    const hiddenMessageIds = new Set(hiddenItems.flatMap((candidate) =>
      "messageId" in candidate && candidate.messageId ? [String(candidate.messageId)] : []));
    const hiddenMessages = projection.messages.filter((message) => hiddenMessageIds.has(String(message.id)));

    // Files first, as V1 did: a restore that fails refuses before the conversation moves.
    // A worktree thread keeps the files each step left (RubatoStepCheckpoints.ts): put the batch's
    // last one back, and make it this turn's checkpoint so the next turn's diff starts there.
    let filesRestored = false;
    const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    const worktree = shell?.worktreePath ?? null;
    const lastCall = cutAfter.nativeItemRef?.nativeId;
    if (restoreFiles && worktree !== null && typeof lastCall === "string") {
      filesRestored = yield* restoreStepCheckpoint({ threadId, toolCallId: lastCall, cwd: worktree })
        .pipe(Effect.mapError((cause) => refuse("files-failed", describe(cause))));
      const checkpoint = projection.checkpoints.find((candidate) => candidate.id === current.checkpointId);
      if (filesRestored && checkpoint) {
        const store = yield* CheckpointStore.CheckpointStore;
        yield* store.captureCheckpoint({ cwd: worktree, checkpointRef: checkpoint.ref })
          .pipe(Effect.mapError((cause) => refuse("files-failed", describe(cause))));
      }
    }
    yield* Effect.tryPromise({
      try: () => bridge.rewindToStep({ threadId, sessionId: session.sessionId, toolCallId }),
      catch: (cause) => refuse("engine-refused", describe(cause)),
    });
    const importer = yield* RubatoThreadImporter;
    yield* importer.cutRun({ run: current, nextOrdinal: projection.runs.length + 1, items: hiddenItems, messages: hiddenMessages })
      .pipe(Effect.mapError((cause) => refuse("write-failed", cause.message)));
    return { runId, cutAfterItemId: cutAfter.id, hiddenItemIds: hiddenItems.map((candidate) => candidate.id),
      hiddenMessageIds: hiddenMessages.map((message) => message.id), filesRestored };
  }).pipe(Effect.provide(services));

  const resume = (threadId: ThreadId) => Effect.gen(function* () {
    const projection = yield* records(threadId);
    const latest = [...projection.runs].filter((run) => run.status !== "rolled_back").sort((left, right) => right.ordinal - left.ordinal)[0];
    if (!latest || latest.status !== "interrupted")
      return yield* refuse("not-rewound", "There is no rewound step to continue from.");
    const bridge = yield* rubatoBridge(latest.providerInstanceId);
    if (bridge === null) return yield* refuse("unavailable", "The Rubato provider is not running.");
    const id = yield* uuid;
    // Only this message becomes the engine's continue (rpc-connection.mjs); a GUI restart in
    // between changes nothing, since the mark is set right here.
    bridge.markStepContinue(threadId);
    yield* orchestrator.dispatch({ type: "message.dispatch", createdBy: "user", creationSource: "web",
      commandId: CommandId.make(`rubato-step-continue:${id}`), threadId, messageId: MessageId.make(`rubato-step-continue:${id}`),
      text: bridge.stepContinueText, attachments: [], manualContinuationOfRunId: latest.id,
      dispatchMode: { type: "start_immediately" } })
      .pipe(Effect.mapError((cause) => refuse("continue-failed", describe(cause))));
    return {};
  }).pipe(Effect.provide(services));

  const answer = <A>(body: Effect.Effect<A, StepRewindRefused>) => body.pipe(
    Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
    Effect.catchTag("StepRewindRefused", (error) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: { code: error.code, message: error.message } }, { status: 409 }))),
  );
  const handle = (route: "rewind" | "continue" | "batch") => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
    const json = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
    if (route === "continue") {
      const body = yield* Schema.decodeUnknownEffect(ContinueBody)(json).pipe(Effect.option);
      if (body._tag === "None") return HttpServerResponse.jsonUnsafe({ error: { code: "invalid", message: "threadId is required" } }, { status: 400 });
      return yield* answer(resume(ThreadId.make(body.value.threadId)));
    }
    const body = yield* Schema.decodeUnknownEffect(StepRewindBody)(json).pipe(Effect.option);
    if (body._tag === "None") return HttpServerResponse.jsonUnsafe({ error: { code: "invalid", message: "threadId and itemId are required" } }, { status: 400 });
    const threadId = ThreadId.make(body.value.threadId);
    return yield* answer(route === "batch" ? preview(threadId, body.value.itemId)
      : rewind(threadId, body.value.itemId, body.value.restoreFiles === true));
  });
  return Layer.mergeAll(
    HttpRouter.add("POST", "/rubato/step-rewind", handle("rewind")),
    HttpRouter.add("POST", "/rubato/step-rewind/continue", handle("continue")),
    HttpRouter.add("POST", "/rubato/step-rewind/batch", handle("batch")),
  );
}));
