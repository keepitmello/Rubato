/**
 * Rewinding the companion room to just before one of the person's messages (companion-edits.mjs,
 * chat/RubatoSegnoChat.tsx), for its edit and its "Rewind from here".
 *
 *   POST /rubato/companion-room/rewind  {threadId, messageId}  → {}
 *
 * A companion's thread is a chat log, not a projection of its turns: the person's messenger
 * messages are written in from the session, and its words arrive as runs of their own. Neither
 * holds a checkpoint, so T3's revert, which counts checkpointed turns, cannot name the place. The
 * message names itself instead. The engine finds it on the session's branch and goes back to just
 * before it (bridge rewindBeforeMessage), and then the thread drops it and everything after
 * (RubatoThreadImporter rollBackFrom). Files stay: the companion's home is its own record.
 *
 * Nothing changes unless the engine finds the message, and nothing changes while a turn runs.
 */
import {
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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

export interface CompanionRewindRecords {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}
export interface CompanionRewindPlan {
  readonly message: OrchestrationV2ConversationMessage;
  /** Whole runs that leave the thread. */
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  /** Rows of the run the message sits in that leave with it; `run` is that run. */
  readonly cut: {
    readonly run: OrchestrationV2Run;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  } | null;
}
export interface CompanionRewindRefusal {
  readonly code: "not-a-message" | "busy";
  readonly message: string;
}

const UNSETTLED: ReadonlySet<OrchestrationV2Run["status"]> = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const millis = (value: unknown): number =>
  typeof value === "string" ? Date.parse(value)
    : typeof value === "number" ? value
      : DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : Number.NaN;

/**
 * What a rewind to just before `messageId` takes out of the thread: every run after the one the
 * message sits in (that run too when the message started it), and the rows of that run stamped at
 * or after the message. A message on no run takes every later run and every later row with it.
 */
export function companionRewindPlan(
  records: CompanionRewindRecords,
  messageId: string,
): CompanionRewindPlan | { readonly refused: CompanionRewindRefusal } {
  const refuse = (code: CompanionRewindRefusal["code"], message: string) => ({ refused: { code, message } });
  const message = records.messages.find((candidate) => candidate.id === messageId);
  const own = message?.runId == null ? undefined : records.runs.find((run) => run.id === message.runId);
  if (message?.role !== "user" || own?.status === "rolled_back")
    return refuse("not-a-message", "This message is no longer in the conversation.");
  if (records.runs.some((run) => UNSETTLED.has(run.status) && !(run.status === "queued" && run.queueHeld === true)))
    return refuse("busy", "Stop the current turn before rewinding.");
  const at = millis(message.createdAt);
  const live = records.runs.filter((run) => run.status !== "rolled_back");
  const starts = own !== undefined && own.userMessageId === message.id;
  const runs = live.filter((run) =>
    own === undefined ? millis(run.requestedAt) >= at : run.ordinal > own.ordinal || (starts && run.id === own.id));
  const gone = new Set<string>(records.runs.filter((run) => run.status === "rolled_back" || runs.includes(run)).map((run) => run.id));
  const stays = (runId: string | null) => runId === null || !gone.has(runId);
  const messages = records.messages.filter((candidate) => stays(candidate.runId) && millis(candidate.createdAt) >= at);
  const messageIds = new Set<string>(messages.map((candidate) => candidate.id));
  const items = records.turnItems.filter((item) => stays(item.runId) && item.type !== "checkpoint"
    && (("messageId" in item && item.messageId != null && messageIds.has(item.messageId))
      || (item.runId === (message.runId ?? null) && millis(item.startedAt ?? item.updatedAt) >= at)));
  const template = own !== undefined && !starts ? own : runs[0] ?? live.at(-1);
  const cut = template === undefined || (messages.length === 0 && items.length === 0) ? null
    : { run: template, items, messages };
  return { message, runs, cut };
}

const SETTLE_ATTEMPTS = 20;
const SETTLE_INTERVAL = "250 millis";

const RewindBody = Schema.Struct({ threadId: Schema.String, messageId: Schema.String });

class CompanionRewindRefused extends Schema.TaggedError<CompanionRewindRefused>()("CompanionRewindRefused", {
  code: Schema.String,
  message: Schema.String,
}) {}
const refused = (code: string, message: string) => new CompanionRewindRefused({ code, message });
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const rubatoCompanionRewindRouteLayer = Layer.unwrap(Effect.gen(function* () {
  const auth = yield* EnvironmentAuth;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const services = yield* Effect.context<RubatoThreadImporter | SqlClient.SqlClient | ProviderInstanceRegistry>();

  const rewind = (threadId: ThreadId, messageId: string) => Effect.gen(function* () {
    const read = orchestrator.getThreadRecords(threadId, ["runs", "turnItems", "messages"]).pipe(
      Effect.mapError((cause) => refused("unknown-thread", describe(cause))));
    let projection = yield* read;
    let plan = companionRewindPlan(projection, messageId);
    // Stop leaves a turn settling for a moment; ask again until it has.
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS && "refused" in plan && plan.refused.code === "busy"; attempt++) {
      yield* Effect.sleep(SETTLE_INTERVAL);
      projection = yield* read;
      plan = companionRewindPlan(projection, messageId);
    }
    if ("refused" in plan) return yield* refused(plan.refused.code, plan.refused.message);
    const session = yield* piSessionOfThread(threadId).pipe(Effect.mapError((cause) => refused("no-session", describe(cause))));
    if (session === null) return yield* refused("no-session", "This conversation has no Rubato session.");
    const instance = (projection.runs.find((run) => run.id === plan.message.runId) ?? projection.runs.at(-1))?.providerInstanceId;
    const bridge = yield* rubatoBridge(instance);
    if (bridge === null) return yield* refused("unavailable", "The Rubato provider is not running.");
    // The engine first: it refuses when it cannot find the message, and then nothing has moved.
    yield* Effect.tryPromise({
      try: () => bridge.rewindBeforeMessage({ threadId, sessionId: session.sessionId, messageId,
        text: plan.message.text, createdAt: DateTime.formatIso(DateTime.makeUnsafe(millis(plan.message.createdAt))) }),
      catch: (cause) => refused("engine-refused", describe(cause)),
    });
    const importer = yield* RubatoThreadImporter;
    yield* importer.rollBackFrom({ threadId, runs: plan.runs,
      ...(plan.cut === null ? {} : { cut: { ...plan.cut, nextOrdinal: projection.runs.length + 1 } }) })
      .pipe(Effect.mapError((cause) => refused("write-failed", cause.message)));
    return {};
  }).pipe(Effect.provide(services));

  const handle = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
    const json = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
    const body = yield* Schema.decodeUnknownEffect(RewindBody)(json).pipe(Effect.option);
    if (body._tag === "None")
      return HttpServerResponse.jsonUnsafe({ error: { code: "invalid", message: "threadId and messageId are required" } }, { status: 400 });
    return yield* rewind(ThreadId.make(body.value.threadId), body.value.messageId).pipe(
      Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
      Effect.catchTag("CompanionRewindRefused", (error) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ error: { code: error.code, message: error.message } }, { status: 409 }))),
    );
  });
  return HttpRouter.add("POST", "/rubato/companion-room/rewind", handle);
}));
