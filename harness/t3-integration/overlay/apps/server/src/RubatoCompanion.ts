import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { sessionThread } from "./RubatoSchedule.ts";
import { answerFromService, authorized, type ServiceSpec } from "./RubatoServiceRoute.ts";
import * as ServerSettings from "./serverSettings.ts";

// Settings > Companion and the rail's Segno button. The companion's settings,
// prompt pieces and conversation live in the Rubato checkout's harness/companion
// (src/companion/service.mjs answers for them). Two actions are answered here
// instead, from this server's own records: which T3 thread shows the companion's
// session, since only this server knows which thread runs in which Pi session
// (RubatoSchedule.ts sessionThread), and what Segno said in a run that just ended,
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
        if (action === "thread") return yield* sessionThread(request, sql);
        if (action === "said") return yield* segnoSaid(request, sql);
        return yield* answerFromService(spec, serverSettings, path, request);
      }),
    );
  }),
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
