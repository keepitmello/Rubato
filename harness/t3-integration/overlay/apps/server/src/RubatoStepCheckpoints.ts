import {
  CheckpointRef,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import type { CheckpointStoreError } from "./checkpointing/Errors.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import { forkParked } from "./serverActivation.ts";

// Rubato: the files each finished tool step left, so a rewind to that step can put them
// back. Kept as a hidden git ref beside the thread's turn checkpoints, and only for a thread
// with its own worktree: restoring a shared checkout could erase another thread's work.

/**
 * Drivers whose tool items carry the tool call id a step rewind lands on: the Rubato provider
 * (Pi's toolCallId) and Antigravity (agy's ACP toolCallId, RubatoStepRewind.ts).
 */
const AGY_STEP_DRIVER = ProviderDriverKind.make("antigravity");
export const STEP_DRIVERS: ReadonlySet<string> = new Set([ProviderDriverKind.make("rubato-pi"), AGY_STEP_DRIVER]);

/** Turn items that stand for one Pi tool call. */
const STEP_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "file_search",
  "web_search",
]);

/**
 * A tool step has finished once its item settles. A failed or stopped call is still a step
 * the user can rewind to, and it can leave files behind too.
 */
const FINISHED_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

/** Where the files a tool step left are kept, beside the thread's turn checkpoints. */
export function stepCheckpointRef(threadId: ThreadId, toolCallId: string): CheckpointRef {
  return CheckpointRef.make(
    `refs/t3/checkpoints/${Base64Url.encode(threadId)}/step/${Base64Url.encode(toolCallId)}`,
  );
}

export interface StepCompletion {
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  /** Set for an agy step: the provider thread whose session must rewind through Rubato's bridge. */
  readonly agyProviderThreadId?: string | null | undefined;
}

/** The Rubato tool step an event finishes, if it finishes one. */
export function stepCompletionOf(event: OrchestrationV2DomainEvent): StepCompletion | undefined {
  if (event.type !== "turn-item.updated") return undefined;
  const item = event.payload;
  const ref = item.nativeItemRef;
  if (
    ref === null ||
    !STEP_DRIVERS.has(ref.driver) ||
    ref.nativeId === null ||
    !STEP_ITEM_TYPES.has(item.type) ||
    !FINISHED_STATUSES.has(item.status)
  ) {
    return undefined;
  }
  return {
    threadId: item.threadId,
    toolCallId: ref.nativeId,
    ...(ref.driver === AGY_STEP_DRIVER ? { agyProviderThreadId: item.providerThreadId } : {}),
  };
}

/** Whether an agy step's session rewinds on agy's own store; a step there can never be rewound to otherwise. */
const agyStepRewinds = Effect.fn("RubatoStepCheckpoints.agyStepRewinds")(function* (
  threadId: ThreadId,
  providerThreadId: string | null,
) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const records = yield* engine.getThreadRecords(threadId, ["providerThreads", "providerSessions"]);
  const providerThread = records.providerThreads.find((candidate) => candidate.id === providerThreadId);
  const session = records.providerSessions.find((candidate) => candidate.id === providerThread?.providerSessionId);
  return session?.capabilities.checkpointing.providerCanRollbackConversation === true;
});

/**
 * Keep the files a finished step left in its thread's worktree. Answers whether a ref was
 * written: a thread without a worktree, or a step already kept, writes nothing.
 */
export const captureStepCheckpoint = Effect.fn("RubatoStepCheckpoints.capture")(function* (
  step: StepCompletion,
) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const thread = yield* engine.getThreadShell(step.threadId);
  if (thread === null || thread.worktreePath === null) return false;
  if (step.agyProviderThreadId !== undefined &&
      !(yield* agyStepRewinds(step.threadId, step.agyProviderThreadId))) return false;
  const cwd = thread.worktreePath;
  const checkpointRef = stepCheckpointRef(step.threadId, step.toolCallId);
  // A step settles once; a repeated settle must not move its snapshot past later steps.
  if (yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef })) return false;
  yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
  return true;
});

/** Put back the files the step left. False when that step has no snapshot. */
export const restoreStepCheckpoint = (input: {
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly cwd: string;
}): Effect.Effect<boolean, CheckpointStoreError, CheckpointStore.CheckpointStore> =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const checkpointRef = stepCheckpointRef(input.threadId, input.toolCallId);
    if (!(yield* checkpoints.hasCheckpointRef({ cwd: input.cwd, checkpointRef }))) return false;
    return yield* checkpoints.restoreCheckpoint({
      cwd: input.cwd,
      checkpointRef,
      fallbackToHead: false,
    });
  }).pipe(Effect.withSpan("RubatoStepCheckpoints.restore"));

/** One event from the live stream: capture when it finishes a Rubato step, warn on failure. */
export const handleStepEvent = (
  event: OrchestrationV2DomainEvent,
): Effect.Effect<void, never, Orchestrator.OrchestratorV2 | CheckpointStore.CheckpointStore> => {
  const step = stepCompletionOf(event);
  if (step === undefined) return Effect.void;
  return captureStepCheckpoint(step).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("failed to keep the files of a tool step", {
            threadId: step.threadId,
            toolCallId: step.toolCallId,
            cause: Cause.pretty(cause),
          }),
    ),
  );
};

/**
 * Follow the live event tail for the server's lifetime. The subscription is unbounded, so a
 * slow capture delays only this fiber, never the writers.
 */
export const start: Effect.Effect<
  void,
  never,
  Scope.Scope | Orchestrator.OrchestratorV2 | CheckpointStore.CheckpointStore
> = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  yield* forkParked(
    Stream.runForEach(engine.streamDomainEvents, handleStepEvent).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Rubato step checkpoint event stream failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );
});

/** Start once with the server; needs the V2 orchestrator and T3's checkpoint store. */
export const layer: Layer.Layer<
  never,
  never,
  Orchestrator.OrchestratorV2 | CheckpointStore.CheckpointStore
> = Layer.effectDiscard(start);
