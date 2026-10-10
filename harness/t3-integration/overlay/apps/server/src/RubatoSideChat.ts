import { CommandId, ThreadId } from "@t3tools/contracts";
import { isSideChatThreadId, SIDE_CHAT_THREAD_PREFIX } from "@t3tools/shared/rubatoSideChat";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
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
import type { PiBridge } from "./provider/Drivers/RubatoPiDriver.ts";

// The right panel's Side chat: a fork of the thread's Rubato conversation, opened beside it.
//
// POST /rubato/side-chat `{ threadId }` forks the thread's Pi session as a side chat (the engine
// adds a hidden notice after the copied history; pi-runtime session-link/side-chat.mjs) and makes
// the thread that shows it here, not through the inventory, which skips side chats. Its id carries
// the side chat prefix, which keeps it out of the client's thread list (packages/shared
// rubatoSideChat.ts). It is not archived: archived threads have no detail to subscribe to. It
// imports no history, so it starts empty at the fork while the model has the whole copy. It keeps
// the source thread's model and modes, which the copied prefix was cached with.
//
// POST /rubato/side-chat/list `{ threadId }` answers the thread's side chats, newest first, so the
// panel can go back to one after its tab was closed.
//
// POST /rubato/side-chat/close `{ threadId }` deletes one: the provider session stops, the engine
// deletes the Pi session (it refuses anything that is not a side chat) and the thread is deleted.
// Side chats of a thread that was deleted are swept the same way when this server starts.

const TITLE_LIMIT = 512;
const SUFFIX = " (side chat)";

export const sideChatTitle = (title: string): string =>
  `${title.trim().slice(0, TITLE_LIMIT - SUFFIX.length)}${SUFFIX}`;

type SideChatSession = { readonly sessionId: string; readonly createdAt: number; readonly sideChatOf?: string };

/** `parentSessionId`'s side chats that have a live thread, newest first. */
export function sideChatsOf(
  parentSessionId: string,
  sessions: ReadonlyArray<SideChatSession>,
  threadsBySession: ReadonlyMap<string, ReadonlyArray<string>>,
): Array<{ threadId: string; createdAt: number }> {
  return sessions
    .filter((session) => session.sideChatOf === parentSessionId)
    .flatMap((session) => {
      const threadId = threadsBySession.get(session.sessionId)?.find(isSideChatThreadId);
      return threadId ? [{ threadId, createdAt: session.createdAt }] : [];
    })
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

/** Side chats whose source conversation no longer has a live thread, with their own threads. */
export function sideChatsToSweep(
  sessions: ReadonlyArray<SideChatSession>,
  threadsBySession: ReadonlyMap<string, ReadonlyArray<string>>,
): Array<{ sessionId: string; threadIds: string[] }> {
  return sessions
    .filter((session) => !(threadsBySession.get(session.sideChatOf ?? "") ?? []).some((id) => !isSideChatThreadId(id)))
    .map((session) => ({
      sessionId: session.sessionId,
      threadIds: (threadsBySession.get(session.sessionId) ?? []).filter(isSideChatThreadId),
    }));
}

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

    // Deletes one side chat (a session whose thread was never made has no `threadId`); null when
    // it is gone, or the engine's reason it was not deleted.
    const discard = (threadId: ThreadId | null, target: { readonly sessionId: string; readonly bridge: PiBridge } | null) =>
      Effect.gen(function* () {
        if (target) {
          // Stopping detaches this app; the engine's discard ends a turn that is still running.
          if (threadId) yield* providers.stopSession({ threadId }).pipe(Effect.ignore);
          const refused = yield* Effect.tryPromise({
            try: () => target.bridge.discardSession(target.sessionId),
            catch: reason,
          }).pipe(Effect.match({ onFailure: (message) => message, onSuccess: () => null }));
          // A session already gone is what deleting wants; any other refusal keeps the thread.
          if (refused !== null && !/No such conversation/i.test(refused)) return refused;
        }
        if (threadId === null) return null;
        const model = yield* query.getCommandReadModel();
        if (model.threads.some((thread) => thread.id === threadId && thread.deletedAt === null))
          yield* engine.dispatch({ type: "thread.delete", commandId: yield* commandId, threadId });
        return null;
      });

    const close = (threadId: ThreadId) =>
      Effect.gen(function* () {
        // Only threads this route made: a wrong id never deletes a real thread.
        if (!isSideChatThreadId(threadId)) return failure(409, "not-side-chat", "Only a side chat can be closed this way.");
        const refused = yield* discard(threadId, yield* bound(threadId));
        return refused === null
          ? HttpServerResponse.jsonUnsafe({ closed: true })
          : failure(409, "not-discarded", `The side chat was not deleted: ${refused}`);
      }).pipe(Effect.catch((cause) => Effect.succeed(failure(500, "failed", `Could not close the side chat: ${reason(cause)}`))));

    /** The live (not deleted) thread bound to each Pi session. */
    const threadsBySession = Effect.gen(function* () {
      const live = new Set(
        (yield* query.getCommandReadModel()).threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
      );
      const bySession = new Map<string, string[]>();
      for (const binding of yield* directory.listBindings()) {
        const sessionId = piSessionOf(binding.resumeCursor);
        if (sessionId === null || !live.has(binding.threadId)) continue;
        bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), binding.threadId]);
      }
      return bySession;
    });

    const list = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const from = yield* bound(threadId);
        if (!from) return HttpServerResponse.jsonUnsafe({ sideChats: [] });
        const sessions = yield* Effect.tryPromise({ try: () => from.bridge.sideChats(), catch: reason });
        const bySession = yield* threadsBySession;
        const sideChats = sideChatsOf(from.sessionId, sessions, bySession).map((entry) => ({
          threadId: entry.threadId,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(entry.createdAt)),
        }));
        return HttpServerResponse.jsonUnsafe({ sideChats });
      }).pipe(Effect.catch((cause) => Effect.succeed(failure(500, "failed", `Could not list side chats: ${reason(cause)}`))));

    // A side chat goes with the thread it came from. Deleting a thread does not reach the engine,
    // so the side chats whose source thread is gone are deleted here, once the providers are up.
    const sweep = Effect.gen(function* () {
      for (const instance of yield* registry.listInstances) {
        const bridge = rubatoBridgeFor(instance);
        if (!bridge || !instance.enabled) continue;
        const sessions = yield* Effect.tryPromise({ try: () => bridge.sideChats(), catch: reason });
        const bySession = yield* threadsBySession;
        for (const orphan of sideChatsToSweep(sessions, bySession)) {
          const target = { sessionId: orphan.sessionId, bridge };
          if (orphan.threadIds.length === 0) yield* discard(null, target);
          for (const sideThreadId of orphan.threadIds) yield* discard(ThreadId.make(sideThreadId), target);
        }
      }
    });
    yield* Effect.forkScoped(
      sweep.pipe(
        Effect.delay("30 seconds"),
        Effect.retry({ schedule: Schedule.spaced("1 minute"), times: 3 }),
        Effect.catch((cause) => Effect.logWarning("Side chats of deleted threads were not swept", { cause })),
      ),
    );

    const route = (path: "/rubato/side-chat" | "/rubato/side-chat/list" | "/rubato/side-chat/close", handle: (threadId: ThreadId) => Effect.Effect<HttpServerResponse.HttpServerResponse>) =>
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

    return Layer.mergeAll(
      route("/rubato/side-chat", open),
      route("/rubato/side-chat/list", list),
      route("/rubato/side-chat/close", close),
    );
  }),
);
