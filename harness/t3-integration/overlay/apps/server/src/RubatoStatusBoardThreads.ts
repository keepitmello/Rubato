import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { threadOfPiSession } from "./provider/RubatoPiSessions.ts";
import { authorized } from "./RubatoServiceRoute.ts";

// The status board's cards open the conversation they show (status-board-edits.mjs). The board
// knows Pi sessions; the app shows threads. POST `{ sessionIds }` answers `{ threads }`, each
// session's live thread or null, by the same lookup the inventory and session messages use
// (threadOfPiSession: the provider binding, a legacy runtime row, or an imported thread). A
// session no thread shows answers null: the page says so instead of making a conversation up.

const MAX_SESSIONS = 200;
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_.:-]{0,127}$/;

export const rubatoStatusBoardThreadsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const sql = yield* SqlClient.SqlClient;
    return HttpRouter.add(
      "POST",
      "/rubato/board-threads",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const asked = (body as { sessionIds?: unknown } | null)?.sessionIds;
        const sessionIds = Array.isArray(asked)
          ? [...new Set(asked.filter((id): id is string => typeof id === "string" && SESSION_ID.test(id)))].slice(0, MAX_SESSIONS)
          : [];
        const threads: Record<string, string | null> = {};
        for (const sessionId of sessionIds) {
          threads[sessionId] = yield* threadOfPiSession(sessionId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.orElseSucceed(() => null),
          );
        }
        return HttpServerResponse.jsonUnsafe({ threads });
      }),
    );
  }),
);
