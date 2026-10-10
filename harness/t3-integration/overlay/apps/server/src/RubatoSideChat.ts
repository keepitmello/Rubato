import { CommandId, ThreadId } from "@t3tools/contracts";
import { isSideChatThreadId, SIDE_CHAT_THREAD_PREFIX } from "@t3tools/shared/rubatoSideChat";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { rubatoBridgeFor } from "./provider/Drivers/RubatoPiDriver.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { authorized } from "./RubatoServiceRoute.ts";
import { piSessionOf } from "./RubatoThreadFork.ts";

// The right panel's Side chat: a fork of the thread's Rubato conversation, opened beside it and
// thrown away when its tab closes.
//
// POST /rubato/side-chat `{ threadId }` forks the thread's Pi session as a side chat (the engine
// adds a hidden notice after the copied history; pi-runtime session-link/side-chat.mjs) and makes
// the thread that shows it here, not through the inventory, which skips side chats. Its id carries
// the side chat prefix, which keeps it out of the client's thread list (packages/shared
// rubatoSideChat.ts). It is not archived: archived threads have no detail to subscribe to. It
// imports no history, so it starts empty at the fork while the model has the whole copy. It keeps
// the source thread's model and modes, which the copied prefix was cached with.
//
// POST /rubato/side-chat/close `{ threadId }` ends it: the provider session stops, the engine
// deletes the Pi session (it refuses anything that is not a side chat) and the thread is deleted.

const TITLE_LIMIT = 512;
const SUFFIX = " (side chat)";

export const sideChatTitle = (title: string): string =>
  `${title.trim().slice(0, TITLE_LIMIT - SUFFIX.length)}${SUFFIX}`;

const failure = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const rubatoSideChatRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const directory = yield* ProviderSessionDirectory;
    const registry = yield* ProviderInstanceRegistry;
    const providers = yield* ProviderService;
    const query = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = crypto.randomUUIDv4.pipe(Effect.map(CommandId.make));

    const bound = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const binding = yield* directory.getBinding(threadId);
        if (Option.isNone(binding)) return null;
        const sessionId = piSessionOf(binding.value.resumeCursor);
        const instanceId = binding.value.providerInstanceId;
        if (sessionId === null || instanceId === undefined) return null;
        const instance = yield* registry.getInstance(instanceId);
        const bridge = instance ? rubatoBridgeFor(instance) : undefined;
        return instance && bridge ? { sessionId, instance, bridge } : null;
      });

    const open = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const source = yield* query.getThreadShellById(threadId);
        if (Option.isNone(source)) return failure(404, "not-found", "This thread no longer exists.");
        const from = yield* bound(threadId);
        if (!from) return failure(409, "not-rubato", "This thread has no Rubato conversation to open a side chat from yet.");
        const forked = yield* Effect.tryPromise({
          try: () => from.bridge.forkSession(from.sessionId, sideChatTitle(source.value.title), { side: true }),
          catch: reason,
        });
        if (!forked) return failure(500, "failed", "Rubato made no side chat.");
        const sideThreadId = ThreadId.make(`${SIDE_CHAT_THREAD_PREFIX}${yield* crypto.randomUUIDv4}`);
        yield* directory.upsert(
          {
            threadId: sideThreadId,
            provider: from.instance.driverKind,
            providerInstanceId: from.instance.instanceId,
            status: "stopped",
            runtimeMode: source.value.runtimeMode,
            resumeCursor: from.bridge.cursor(forked.sessionId),
            runtimePayload: { cwd: forked.cwd },
          },
          { onConflict: "ignore" },
        );
        yield* engine.dispatch({
          type: "thread.create",
          commandId: yield* commandId,
          threadId: sideThreadId,
          projectId: source.value.projectId,
          title: sideChatTitle(source.value.title),
          modelSelection: source.value.modelSelection,
          runtimeMode: source.value.runtimeMode,
          interactionMode: source.value.interactionMode,
          branch: source.value.branch,
          worktreePath: source.value.worktreePath,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return HttpServerResponse.jsonUnsafe({ threadId: sideThreadId });
      }).pipe(Effect.catch((cause) => Effect.succeed(failure(500, "failed", `Could not open a side chat: ${reason(cause)}`))));

    const close = (threadId: ThreadId) =>
      Effect.gen(function* () {
        // Only threads this route made: a wrong id never deletes a real thread.
        if (!isSideChatThreadId(threadId)) return failure(409, "not-side-chat", "Only a side chat can be closed this way.");
        const thread = yield* query.getThreadShellById(threadId);
        const target = yield* bound(threadId);
        if (target) {
          // Stopping detaches this app; the engine's discard ends a turn that is still running.
          yield* providers.stopSession({ threadId }).pipe(Effect.ignore);
          const discarded = yield* Effect.tryPromise({
            try: () => target.bridge.discardSession(target.sessionId),
            catch: reason,
          }).pipe(Effect.match({ onFailure: (message) => message, onSuccess: () => null }));
          // A session already gone is what closing wants; any other refusal keeps the thread.
          if (discarded !== null && !/No such conversation/i.test(discarded))
            return failure(409, "not-discarded", `The side chat was not deleted: ${discarded}`);
        }
        if (Option.isSome(thread))
          yield* engine.dispatch({ type: "thread.delete", commandId: yield* commandId, threadId });
        return HttpServerResponse.jsonUnsafe({ closed: true });
      }).pipe(Effect.catch((cause) => Effect.succeed(failure(500, "failed", `Could not close the side chat: ${reason(cause)}`))));

    const route = (path: "/rubato/side-chat" | "/rubato/side-chat/close", handle: (threadId: ThreadId) => Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
      HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
          const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
          const threadId = (body as { threadId?: unknown } | null)?.threadId;
          if (typeof threadId !== "string" || threadId.length === 0)
            return failure(400, "invalid", "threadId is missing.");
          return yield* handle(ThreadId.make(threadId));
        }),
      );

    return Layer.mergeAll(route("/rubato/side-chat", open), route("/rubato/side-chat/close", close));
  }),
);
