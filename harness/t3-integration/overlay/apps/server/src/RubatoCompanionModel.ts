/**
 * The companion room's model picker (companion-edits.mjs, ChatView's onProviderModelSelect).
 *
 *   POST /rubato/companion-room/model  {threadId, modelSelection}  → {}
 *
 * In any other thread a pick waits in the composer until the next send. A companion runs on its
 * own most of the time (the clock, a wake, a retry after a rate limit), so a pick that waited
 * there left that work on the old model (user item bceb5547). Here the engine switches the
 * companion's session now (bridge setCompanionModel), and the thread keeps the pick, so the phone
 * and the next turn send the same model.
 */
import { CommandId, ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import { ProviderInstanceRegistry } from "./provider/ProviderInstanceRegistry.ts";
import { piSessionOfThread, rubatoBridge } from "./provider/RubatoPiSessions.ts";
import { authorized } from "./RubatoServiceRoute.ts";

const ModelBody = Schema.Struct({ threadId: Schema.String, modelSelection: ModelSelection });

class CompanionModelRefused extends Schema.TaggedError<CompanionModelRefused>()("CompanionModelRefused", {
  code: Schema.String,
  message: Schema.String,
}) {}
const refused = (code: string, message: string) => new CompanionModelRefused({ code, message });
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const rubatoCompanionModelRouteLayer = Layer.unwrap(Effect.gen(function* () {
  const auth = yield* EnvironmentAuth;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const services = yield* Effect.context<SqlClient.SqlClient | ProviderInstanceRegistry>();

  const apply = Effect.fn("RubatoCompanionModel.apply")(function* (threadId: ThreadId, modelSelection: ModelSelection) {
    const session = yield* piSessionOfThread(threadId).pipe(Effect.mapError((cause) => refused("no-session", describe(cause))));
    if (session === null) return yield* refused("no-session", "This conversation has no Rubato session.");
    const bridge = yield* rubatoBridge(modelSelection.instanceId);
    if (bridge === null) return yield* refused("unavailable", "The Rubato provider is not running.");
    // The engine first: it refuses any conversation that is not a companion's, and then the thread keeps its pick.
    yield* Effect.tryPromise({
      try: () => bridge.setCompanionModel({ threadId, sessionId: session.sessionId, model: modelSelection.model }),
      catch: (cause) => refused("engine-refused", describe(cause)),
    });
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(`rubato-companion-model:${threadId}:${yield* Clock.currentTimeMillis}`),
      threadId,
      modelSelection,
    }).pipe(Effect.mapError((cause) => refused("write-failed", describe(cause))));
    return {};
  }, Effect.provide(services));

  const handle = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
    const json = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
    const body = yield* Schema.decodeUnknownEffect(ModelBody)(json).pipe(Effect.option);
    if (body._tag === "None")
      return HttpServerResponse.jsonUnsafe({ error: { code: "invalid", message: "threadId and modelSelection are required" } }, { status: 400 });
    return yield* apply(ThreadId.make(body.value.threadId), body.value.modelSelection).pipe(
      Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
      Effect.catchTag("CompanionModelRefused", (error) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ error: { code: error.code, message: error.message } }, { status: 409 }))),
    );
  });
  return HttpRouter.add("POST", "/rubato/companion-room/model", handle);
}));
