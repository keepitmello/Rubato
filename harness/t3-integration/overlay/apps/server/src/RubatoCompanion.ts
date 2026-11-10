import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { threadOfPiSession } from "./provider/RubatoPiSessions.ts";
import { answerFromService, authorized, type ServiceSpec } from "./RubatoServiceRoute.ts";
import * as ServerSettings from "./serverSettings.ts";

// Settings > Companion and the rail's Segno button. The companion's settings,
// prompt pieces and conversation live in the Rubato checkout's harness/companion
// (src/companion/service.mjs answers for them). Two actions are answered here
// instead, from this server's own records: which T3 thread shows the companion's
// session, since only this server knows which thread runs in which Pi session
// (companionThread below), and what Segno said in a run that just ended,
// for the notification that reads like a messenger's (segnoSaid).
const spec: ServiceSpec = {
  route: "/rubato/companion",
  file: "companion/service.mjs",
  service: "companionService",
  handler: "handleCompanionRequest",
  name: "companion",
};

export const rubatoCompanionRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* OrchestratorV2;
    const crypto = yield* Crypto.Crypto;
    const archived = (threadId: string) =>
      sql<{ readonly archived_at: string | null }>`
        SELECT archived_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `.pipe(Effect.map((rows) => rows[0]?.archived_at != null));
    const unarchive = (threadId: string) =>
      Effect.gen(function* () {
        const commandId = CommandId.make(yield* crypto.randomUUIDv4());
        yield* orchestrator.dispatch({ type: "thread.unarchive", commandId, threadId: ThreadId.make(threadId) });
      });
    return HttpRouter.add(
      "*",
      `${spec.route}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
        const action = new URL(request.url, "http://local").pathname
          .replace(/\/+$/, "")
          .split("/")
          .at(-1);
        if (action === "thread") return yield* companionThread(request, sql, { archived, unarchive });
        if (action === "said") return yield* segnoSaid(request, sql);
        return yield* answerFromService(spec, serverSettings, path, request);
      }),
    );
  }),
);

/**
 * The companion's room for its current conversation: the thread, taken out of the archive when it
 * was archived. The room cannot open an archived thread (the client's thread list leaves it out,
 * the thread route reads it as missing and goes home), so a room thread must not stay there. On
 * 2026-11-09 Roo's thread was archived while two engines fought over its home, and from then the
 * rail's Roo button led home.
 */
export interface CompanionRoomIo<E, U, R> {
  readonly archived: (threadId: string) => Effect.Effect<boolean, E, R>;
  readonly unarchive: (threadId: string) => Effect.Effect<void, U, R>;
}

export const companionRoom = <E, U, R>(threadId: string | null, io: CompanionRoomIo<E, U, R>) =>
  Effect.gen(function* () {
    if (threadId === null) return null;
    if (yield* io.archived(threadId)) {
      // A failed unarchive still answers the thread; the next refresh tries again.
      yield* io.unarchive(threadId).pipe(
        Effect.catch((cause) => Effect.logWarning("companion room: unarchive failed", { threadId, cause })),
      );
    }
    return threadId;
  });

/**
 * The `thread` action: which T3 thread shows a companion's Pi session (`{ sessionId }`), or null
 * while the app has not picked the session up yet. `current: true` marks the conversation the
 * companion runs in now, whose thread is its room (companionRoom); an earlier conversation's
 * thread is only looked up.
 */
const companionThread = <E, U, R>(
  request: HttpServerRequest.HttpServerRequest,
  sql: SqlClient.SqlClient,
  io: CompanionRoomIo<E, U, R>,
) =>
  Effect.gen(function* () {
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const { sessionId, current } = (body ?? {}) as { sessionId?: unknown; current?: unknown };
    if (typeof sessionId !== "string" || sessionId.length === 0)
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "invalid", message: "sessionId is missing." } },
        { status: 400 },
      );
    const found = yield* threadOfPiSession(sessionId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const threadId = current === true ? yield* companionRoom(found, io) : found;
    return HttpServerResponse.jsonUnsafe({ threadId });
  }).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.jsonUnsafe(
        { error: { code: "thread-lookup-failed", message: "Could not look up the session's thread." } },
        { status: 500 },
      ),
    ),
  );

/**
 * Segno's newest finished message in a run of its thread. The thread holds only the person's
 * messages and what Segno sent with reply or say, so that message is a reply: its own run, or the
 * run the person's message opened. `text` is null when the run carried no reply, and no
 * notification is raised then.
 */
const segnoSaid = (request: HttpServerRequest.HttpServerRequest, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const { threadId, runId } = (body ?? {}) as { threadId?: unknown; runId?: unknown };
    if (typeof threadId !== "string" || threadId === "" || typeof runId !== "string" || runId === "")
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "invalid", message: "threadId and runId are needed." } },
        { status: 400 },
      );
    const rows = yield* sql<{ readonly text: string | null }>`
      SELECT json_extract(m.payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages m
      WHERE m.thread_id = ${threadId} AND m.run_id = ${runId} AND m.role = 'assistant' AND m.streaming = 0
      ORDER BY m.created_at DESC, m.message_id DESC
      LIMIT 1
    `;
    return HttpServerResponse.jsonUnsafe({ text: rows[0]?.text ?? null });
  }).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.jsonUnsafe(
        { error: { code: "said-lookup-failed", message: "Could not read what Segno said." } },
        { status: 500 },
      ),
    ),
  );
