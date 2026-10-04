import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { rubatoBridgeFor } from "./provider/Drivers/RubatoPiDriver.ts";
import { importedPiThreadId, syncRubatoInventoryNow } from "./provider/RubatoPiInventory.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { authorized } from "./RubatoServiceRoute.ts";

// "Fork thread" in the sidebar's thread menu. POST `{ threadId }` copies the Pi session
// behind the thread (its completed history; a running turn stays behind) into a new
// session named after the thread, and answers `{ threadId }` of the thread that shows it.
// That thread is the inventory's (RubatoPiInventory.ts): it imports the copy like any
// session started elsewhere, with the conversation's text and no tool rows, and binds it
// so the next message continues the copy with everything the model saw.
// T3 files an imported history as settled; a fork was asked for to continue, so it is
// un-settled into the active list once its history has landed.

/** Pi limits a session title to 512 characters. */
const TITLE_LIMIT = 512;
const SUFFIX = " (fork)";
const WAIT_MS = 15_000;
/** The history import follows the thread's creation in the same inventory pass. */
const SETTLE_WAIT_MS = 3_000;

export const forkTitle = (title: string): string =>
  `${title.trim().slice(0, TITLE_LIMIT - SUFFIX.length)}${SUFFIX}`;

/** The Pi session a thread's binding resumes, or null when it does not run on Rubato. */
export function piSessionOf(resumeCursor: unknown): string | null {
  if (!resumeCursor || typeof resumeCursor !== "object") return null;
  const { kind, sessionId } = resumeCursor as Record<string, unknown>;
  return kind === "rubato-pi" && typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

const failure = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const rubatoThreadForkRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const directory = yield* ProviderSessionDirectory;
    const registry = yield* ProviderInstanceRegistry;
    const query = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;

    const until = (threadId: ThreadId, ready: (thread: { readonly settledAt: string | null }) => boolean, ms: number) =>
      query.getThreadShellById(threadId).pipe(
        Effect.flatMap((thread) =>
          Option.isSome(thread) && ready(thread.value) ? Effect.succeed(true) : Effect.fail("pending" as const),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis") }),
        Effect.timeoutOption(ms),
        Effect.map(Option.isSome),
      );

    const fork = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const source = yield* query.getThreadShellById(threadId);
        if (Option.isNone(source)) return failure(404, "not-found", "This thread no longer exists.");
        const binding = yield* directory.getBinding(threadId);
        const sessionId = Option.isSome(binding) ? piSessionOf(binding.value.resumeCursor) : null;
        const instanceId = Option.isSome(binding) ? binding.value.providerInstanceId : undefined;
        if (sessionId === null || instanceId === undefined)
          return failure(409, "not-rubato", "This thread has no Rubato conversation to fork yet.");
        const instance = yield* registry.getInstance(instanceId);
        const bridge = instance ? rubatoBridgeFor(instance) : undefined;
        if (!instance || !bridge) return failure(503, "unavailable", "The Rubato provider is not running.");
        const forked = yield* Effect.tryPromise({
          try: () => bridge.forkSession(sessionId, forkTitle(source.value.title)),
          catch: reason,
        });
        if (!forked) return failure(500, "failed", "Rubato made no fork.");
        const forkThreadId = importedPiThreadId(instance.instanceId, forked.serverId, forked.sessionId);
        yield* syncRubatoInventoryNow;
        if (!(yield* until(forkThreadId, () => true, WAIT_MS)))
          return failure(504, "not-shown", `Forked into Rubato session ${forked.sessionId}, but no thread showed it yet.`);
        // A fork with no finished turn imports no history and never settles.
        if (yield* until(forkThreadId, (thread) => thread.settledAt !== null, SETTLE_WAIT_MS))
          yield* engine.dispatch({
            type: "thread.unsettle",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId: forkThreadId,
            reason: "user",
          });
        return HttpServerResponse.jsonUnsafe({ threadId: forkThreadId });
      }).pipe(Effect.catch((cause) => Effect.succeed(failure(500, "failed", `Could not fork this thread: ${reason(cause)}`))));

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
        return yield* fork(ThreadId.make(threadId));
      }),
    );
  }),
);
