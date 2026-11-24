import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import { forkWholeThread } from "./provider/RubatoPiSessions.ts";
import { authorized } from "./RubatoServiceRoute.ts";

// "Fork thread" in the sidebar's thread menus. POST `{ threadId }` copies the whole Rubato
// conversation behind the thread — its completed history, a last failed or stopped reply
// included; a turn still running stays behind — and answers `{ threadId }` of the new thread
// that shows it. The copy and the thread are forkWholeThread's (RubatoPiSessions.ts); this
// route authenticates and hands over. T3's own fork works from one completed run, which an
// imported thread or one that ended on a failed turn does not have.
//
// An Antigravity thread forks with T3's own fork at its latest stable point. agy has no ACP fork,
// but through Rubato's approval bridge `session/fork` copies agy's own conversation
// (agy-native-edits.mjs), so the new thread continues natively, not from a replayed summary.

const failure = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });
const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

export const rubatoThreadForkRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const crypto = yield* SecureRandom.SecureRandom;
    // The fork runs on the services this layer was built with.
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof forkWholeThread>>>();

    /** The new thread's id: T3's fork for a thread on agy, the engine's copy for a Rubato thread. */
    const forkThread = Effect.fn("RubatoThreadFork.forkThread")(function* (threadId: ThreadId) {
      const projection = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]);
      const active = projection.providerThreads.find((candidate) =>
        candidate.providerInstanceId === projection.thread.modelSelection.instanceId);
      if (active?.driver !== "antigravity") return yield* forkWholeThread(threadId).pipe(Effect.provide(context));
      const id = yield* crypto.uuidV4();
      const target = ThreadId.make(id);
      yield* orchestrator.dispatch({
        type: "thread.fork", commandId: CommandId.make(`rubato-thread-fork:${id}`), createdBy: "user",
        creationSource: "web", sourceThreadId: threadId, targetThreadId: target,
        sourcePoint: { type: "latest_stable" }, title: `${projection.thread.title} (fork)`,
      });
      return target;
    });

    return HttpRouter.add(
      "POST",
      "/rubato/thread-fork",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const threadId = (body as { threadId?: unknown } | null)?.threadId;
        if (typeof threadId !== "string" || threadId.length === 0)
          return failure(400, "invalid", "threadId is missing.");
        return yield* forkThread(ThreadId.make(threadId)).pipe(
          Effect.map((forked) => HttpServerResponse.jsonUnsafe({ threadId: forked })),
          Effect.catchCause((cause) =>
            Effect.succeed(failure(409, "not-forked", `The thread was not forked: ${reason(Cause.squash(cause))}`)),
          ),
        );
      }),
    );
  }),
);
