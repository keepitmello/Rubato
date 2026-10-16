import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { forkWholeThread } from "./provider/RubatoPiSessions.ts";
import { authorized } from "./RubatoServiceRoute.ts";

// "Fork thread" in the sidebar's thread menus. POST `{ threadId }` copies the whole Rubato
// conversation behind the thread — its completed history, a last failed or stopped reply
// included; a turn still running stays behind — and answers `{ threadId }` of the new thread
// that shows it. The copy and the thread are forkWholeThread's (RubatoPiSessions.ts); this
// route authenticates and hands over. T3's own fork works from one completed run, which an
// imported thread or one that ended on a failed turn does not have.

const failure = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });
const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

export const rubatoThreadForkRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    // The fork runs on the services this layer was built with.
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof forkWholeThread>>>();

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
        return yield* forkWholeThread(ThreadId.make(threadId)).pipe(
          Effect.provide(context),
          Effect.map((forked) => HttpServerResponse.jsonUnsafe({ threadId: forked })),
          Effect.catchCause((cause) =>
            Effect.succeed(failure(409, "not-forked", `The thread was not forked: ${reason(Cause.squash(cause))}`)),
          ),
        );
      }),
    );
  }),
);
