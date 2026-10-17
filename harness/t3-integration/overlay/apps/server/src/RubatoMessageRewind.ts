/**
 * Where editing a sent message rewinds to (turn-actions-edits.mjs, chat/RubatoMessageEdit.tsx).
 *
 *   POST /rubato/message-rewind/target  {threadId, messageId}  → {turnCount, checkpointId, scopeId}
 *
 * The edit drops the message's turn and everything after it, so the conversation goes back to
 * the checkpoint of the latest turn before it. The server answers because only it holds every
 * checkpoint: the web client loads a long thread a window at a time, with the checkpoints of
 * the turns in that window only.
 *
 * Some turns before the message leave no checkpoint and are skipped, dropped with the rest: a
 * message queued during a turn and then sent into it cancels its queued turn before it starts,
 * and a failed or cancelled turn captures nothing. A finished or stopped turn without a ready
 * checkpoint refuses instead, so the rewind never goes further back than the user asked.
 */
import {
  MessageId,
  ThreadId,
  type CheckpointId,
  type CheckpointScopeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import { authorized } from "./RubatoServiceRoute.ts";

export interface MessageRewindTarget {
  /** The run ordinal the conversation goes back to; 0 is the thread start. */
  readonly turnCount: number;
  readonly checkpointId: CheckpointId;
  readonly scopeId: CheckpointScopeId;
}
export interface MessageRewindRefusal {
  readonly code: "not-a-turn" | "busy" | "no-checkpoint";
  readonly message: string;
}

export interface MessageRewindRecords {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId">
  >;
  readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "role" | "runId">>;
  readonly checkpoints: ReadonlyArray<
    Pick<
      OrchestrationV2Checkpoint,
      "id" | "scopeId" | "runId" | "appRunOrdinal" | "ordinalWithinScope" | "status"
    >
  >;
}

const UNSETTLED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
// Turns that may leave no checkpoint: the rewind drops them with the edited turn.
const SKIPPABLE: ReadonlySet<OrchestrationV2Run["status"]> = new Set(["failed", "cancelled"]);

export function messageRewindTarget(
  records: MessageRewindRecords,
  messageId: string,
): MessageRewindTarget | { readonly refused: MessageRewindRefusal } {
  const refuse = (code: MessageRewindRefusal["code"], message: string) => ({
    refused: { code, message },
  });
  const message = records.messages.find((candidate) => candidate.id === messageId);
  const run =
    message?.runId == null
      ? undefined
      : records.runs.find((candidate) => candidate.id === message.runId);
  if (message?.role !== "user" || run === undefined || run.status === "rolled_back") {
    return refuse("not-a-turn", "This message is no longer in the thread.");
  }
  if (run.userMessageId !== message.id) {
    return refuse("not-a-turn", "Only a message that started a turn can be edited.");
  }
  // A queued or running turn would outlive the rollback, and a turn still saving its
  // checkpoint is not yet a place to go back to.
  if (records.runs.some((candidate) => UNSETTLED.has(candidate.status))) {
    return refuse("busy", "Stop the current turn before editing a message.");
  }
  const ready = (candidate: MessageRewindRecords["checkpoints"][number]) =>
    candidate.status === "ready";
  const earlier = records.runs
    .filter((candidate) => candidate.ordinal < run.ordinal && candidate.status !== "rolled_back")
    .sort((left, right) => right.ordinal - left.ordinal);
  for (const candidate of earlier) {
    const checkpoint = records.checkpoints.find(
      (entry) =>
        ready(entry) && entry.runId === candidate.id && entry.appRunOrdinal === candidate.ordinal,
    );
    if (checkpoint !== undefined) {
      return {
        turnCount: candidate.ordinal,
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
      };
    }
    if (!SKIPPABLE.has(candidate.status)) {
      return refuse(
        "no-checkpoint",
        `Turn ${candidate.ordinal} before this message has no checkpoint to rewind to.`,
      );
    }
  }
  const threadStart = records.checkpoints.find(
    (entry) => ready(entry) && entry.appRunOrdinal === null && entry.ordinalWithinScope === 0,
  );
  if (threadStart === undefined) {
    return refuse("no-checkpoint", "This thread has no starting checkpoint to rewind to.");
  }
  return { turnCount: 0, checkpointId: threadStart.id, scopeId: threadStart.scopeId };
}

const TargetBody = Schema.Struct({ threadId: Schema.String, messageId: Schema.String });

export const rubatoMessageRewindRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
      const json = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
      const body = yield* Schema.decodeUnknownEffect(TargetBody)(json).pipe(Effect.option);
      if (body._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { error: { code: "invalid", message: "threadId and messageId are required" } },
          { status: 400 },
        );
      }
      const records = yield* orchestrator
        .getThreadRecords(ThreadId.make(body.value.threadId), ["runs", "messages", "checkpoints"], {
          messageRoles: ["user"],
        })
        .pipe(Effect.option);
      if (records._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { error: { code: "unknown-thread", message: "This thread is not on this server." } },
          { status: 404 },
        );
      }
      const target = messageRewindTarget(records.value, MessageId.make(body.value.messageId));
      return "refused" in target
        ? HttpServerResponse.jsonUnsafe({ error: target.refused }, { status: 409 })
        : HttpServerResponse.jsonUnsafe(target);
    });
    return HttpRouter.add("POST", "/rubato/message-rewind/target", handle);
  }),
);
