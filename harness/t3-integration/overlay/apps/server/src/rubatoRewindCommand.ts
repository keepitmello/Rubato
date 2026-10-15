import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

// `/rewind [turns]` typed in a Rubato thread (bridge commands.mjs). The phone app draws no
// rewind button, so the command asks T3 for its own conversation revert, which rewinds Pi
// through rollbackThread and drops the rows on every screen, the command's own included.
// The command's turn is numbered once it settles (its checkpoint), and the revert keeps
// the turns before the `turns` that precede it.

/**
 * The checkpoint count to revert to, undefined while the command's turn has no checkpoint
 * yet, or why it cannot rewind.
 */
export function rewindCommandTarget(
  checkpoints: ReadonlyArray<{ readonly turnId: string; readonly checkpointTurnCount: number }>,
  commandTurnId: string,
  turns: number,
): number | string | undefined {
  const own = checkpoints.find((checkpoint) => checkpoint.turnId === commandTurnId);
  if (own === undefined) return undefined;
  const target = own.checkpointTurnCount - 1 - turns;
  return target >= 0
    ? target
    : `This conversation has only ${own.checkpointTurnCount - 1} turns to rewind.`;
}

/**
 * Once the command's turn is numbered, T3's own conversation revert; the bridge calls this
 * after it settles that turn. A failure is told in the thread the way a failed revert is.
 */
export const rewindAfterCommand = (
  threadId: string,
  request: { readonly afterTurn: string; readonly turns: number },
  waitMs = 15_000,
) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const id = ThreadId.make(threadId);
    const target = yield* query.getThreadDetailById(id, { activityKinds: [] }).pipe(
      Effect.flatMap((thread) => {
        const resolved = Option.isSome(thread)
          ? rewindCommandTarget(thread.value.checkpoints, request.afterTurn, request.turns)
          : "This thread no longer exists.";
        return resolved === undefined ? Effect.fail("pending" as const) : Effect.succeed(resolved);
      }),
      Effect.retry({ schedule: Schedule.spaced("100 millis") }),
      Effect.timeoutOption(waitMs),
    );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const commandId = CommandId.make(yield* crypto.randomUUIDv4);
    if (Option.isSome(target) && typeof target.value === "number") {
      yield* engine.dispatch({
        type: "thread.conversation.revert",
        commandId,
        threadId: id,
        turnCount: target.value,
        createdAt,
      });
      return;
    }
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId,
      threadId: id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Rewind failed",
        payload: {
          detail: Option.isSome(target)
            ? String(target.value)
            : "/rewind: this command's turn was not recorded in time.",
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });
