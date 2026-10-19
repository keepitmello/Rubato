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
// (src/companion/service.mjs answers for them). One action is answered here
// instead: which T3 thread shows the companion's session, since only this server
// knows which thread runs in which Pi session (RubatoSchedule.ts sessionThread).
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
        return yield* answerFromService(spec, serverSettings, path, request);
      }),
    );
  }),
);
