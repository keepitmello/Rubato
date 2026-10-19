import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { threadOfPiSession } from "./provider/RubatoPiSessions.ts";
import { answerFromService, authorized, type ServiceSpec } from "./RubatoServiceRoute.ts";
import * as ServerSettings from "./serverSettings.ts";

// Settings > Scheduled Tasks. Tasks and runs live in the Rubato checkout's
// schedule store (src/schedule/service.mjs answers for them). One action is
// answered here instead: which T3 thread shows a run's session, since only
// this server knows which thread runs in which Pi session (RubatoPiSessions.ts).
const spec: ServiceSpec = {
  route: "/rubato/schedule",
  file: "schedule/service.mjs",
  service: "scheduleService",
  handler: "handleScheduleRequest",
  name: "schedule",
};

/**
 * The `thread` action: which T3 thread shows a Pi session (`{ sessionId }` in the body), or null
 * while the app has not picked the session up yet. RubatoCompanion.ts answers with it too.
 */
export const sessionThread = (
  request: HttpServerRequest.HttpServerRequest,
  sql: SqlClient.SqlClient,
) =>
  Effect.gen(function* () {
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const { sessionId } = (body ?? {}) as { sessionId?: unknown };
    if (typeof sessionId !== "string" || sessionId.length === 0)
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "invalid", message: "sessionId is missing." } },
        { status: 400 },
      );
    // Engine session ids are unique across engines, so the run's serverId is not needed.
    const threadId = yield* threadOfPiSession(sessionId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return HttpServerResponse.jsonUnsafe({ threadId });
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error: {
              code: "thread-lookup-failed",
              message: "Could not look up the session's thread.",
            },
          },
          { status: 500 },
        ),
      ),
    ),
  );

export const rubatoScheduleRouteLayer = Layer.unwrap(
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
        return yield* answerFromService(spec, serverSettings, path, request);
      }),
    );
  }),
);
