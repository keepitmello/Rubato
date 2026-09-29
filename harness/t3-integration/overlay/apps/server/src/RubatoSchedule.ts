import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { answerFromService, authorized, type ServiceSpec } from "./RubatoServiceRoute.ts";
import * as ServerSettings from "./serverSettings.ts";

// Settings > Scheduled Tasks. Tasks and runs live in the Rubato checkout's
// schedule store (src/schedule/service.mjs answers for them). One action is
// answered here instead: which T3 thread shows a run's session, since only
// this server holds the bindings from Pi sessions to threads.
const spec: ServiceSpec = {
  route: "/rubato/schedule",
  file: "schedule/service.mjs",
  service: "scheduleService",
  handler: "handleScheduleRequest",
  name: "schedule",
};

/** The thread bound to a Pi session, as the inventory binds every session it shows. */
export function threadForSession(
  bindings: ReadonlyArray<{ readonly threadId: string; readonly resumeCursor?: unknown }>,
  sessionId: string,
  serverId: string | null,
): string | null {
  for (const binding of bindings) {
    const cursor = binding.resumeCursor;
    if (!cursor || typeof cursor !== "object") continue;
    const { kind, sessionId: bound, serverId: server } = cursor as Record<string, unknown>;
    if (kind !== "rubato-pi" || bound !== sessionId) continue;
    if (serverId !== null && server !== serverId) continue;
    return binding.threadId;
  }
  return null;
}

export const rubatoScheduleRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    const directory = yield* ProviderSessionDirectory;
    const query = yield* ProjectionSnapshotQuery;

    const thread = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const { sessionId, serverId } = (body ?? {}) as { sessionId?: unknown; serverId?: unknown };
        if (typeof sessionId !== "string" || sessionId.length === 0)
          return HttpServerResponse.jsonUnsafe(
            { error: { code: "invalid", message: "sessionId is missing." } },
            { status: 400 },
          );
        const bindings = yield* directory.listBindings();
        const threadId = threadForSession(bindings, sessionId, typeof serverId === "string" ? serverId : null);
        if (threadId === null) return HttpServerResponse.jsonUnsafe({ threadId: null });
        // A binding can outlive its thread; a deleted one has nothing to open.
        const model = yield* query.getCommandReadModel();
        const found = model.threads.find((entry) => entry.id === threadId);
        const open = found !== undefined && (found.deletedAt === null || found.deletedAt === undefined);
        return HttpServerResponse.jsonUnsafe({ threadId: open ? threadId : null });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: { code: "thread-lookup-failed", message: "Could not look up the session's thread." } },
              { status: 500 },
            ),
          ),
        ),
      );

    return HttpRouter.add(
      "*",
      `${spec.route}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
        const action = new URL(request.url, "http://local").pathname.replace(/\/+$/, "").split("/").at(-1);
        if (action === "thread") return yield* thread(request);
        return yield* answerFromService(spec, serverSettings, path, request);
      }),
    );
  }),
);
