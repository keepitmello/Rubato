import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { rubatoBridgeFor } from "./provider/Drivers/RubatoPiDriver.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { authorized } from "./RubatoServiceRoute.ts";

// "Rewind & continue" on a tool step. The rewind itself is T3's revert with a step
// (rubatoStepRewind.ts); this runs the conversation again from the step's results,
// adding no message. POST `{ threadId }`; Rubato opens the run's turn as a wake does.

const failure = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const rubatoStepContinueRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const directory = yield* ProviderSessionDirectory;
    const registry = yield* ProviderInstanceRegistry;

    const resume = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const binding = yield* directory.getBinding(threadId);
        const instanceId = Option.isSome(binding) ? binding.value.providerInstanceId : undefined;
        if (instanceId === undefined)
          return failure(409, "not-rubato", "This thread has no Rubato conversation to continue.");
        const instance = yield* registry.getInstance(instanceId);
        const bridge = instance ? rubatoBridgeFor(instance) : undefined;
        if (!bridge) return failure(503, "unavailable", "The Rubato provider is not running.");
        if (!bridge.hasSession(threadId))
          return failure(
            409,
            "detached",
            "Send a message to reconnect this thread before continuing.",
          );
        const continued = yield* Effect.tryPromise({
          try: () => bridge.continueThread(threadId),
          catch: reason,
        }).pipe(Effect.match({ onFailure: (message) => message, onSuccess: () => null }));
        if (continued !== null) return failure(409, "refused", continued);
        return HttpServerResponse.jsonUnsafe({ threadId });
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed(failure(500, "failed", `Could not continue: ${reason(cause)}`)),
        ),
      );

    return HttpRouter.add(
      "POST",
      "/rubato/step-rewind/continue",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const threadId = (body as { threadId?: unknown } | null)?.threadId;
        if (typeof threadId !== "string" || threadId.length === 0)
          return failure(400, "invalid", "threadId is missing.");
        return yield* resume(ThreadId.make(threadId));
      }),
    );
  }),
);
