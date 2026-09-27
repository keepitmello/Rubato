import { pathToFileURL } from "node:url";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { bridgeModuleOf } from "./RubatoMemory.ts";
import * as ServerSettings from "./serverSettings.ts";

// The warmer switch in the context ring's popover. The bridge module the Rubato
// provider runs is imported by the same URL here, so this is the provider's own
// module instance and it answers with the provider's engine connection.
interface CacheWarmingModule {
  handleCacheWarmingRequest(request: Request): Promise<Response>;
}

function loadBridge(file: string): Promise<CacheWarmingModule> {
  return import(/* @vite-ignore */ pathToFileURL(file).href).then((module: unknown) => {
    if (!module || typeof module !== "object" || !("handleCacheWarmingRequest" in module))
      throw new Error("The Rubato bridge has no cache warming handler");
    return module as CacheWarmingModule;
  });
}

export const rubatoCacheWarmingRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    return HttpRouter.add("*", "/rubato/cache-warming", handle(auth, serverSettings, path));
  }),
);

function handle(
  auth: EnvironmentAuth["Service"],
  serverSettings: ServerSettings.ServerSettingsService["Service"],
  path: Path.Path,
) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session) || !session.value.scopes.includes(AuthOrchestrationOperateScope))
      return HttpServerResponse.empty({ status: 401 });
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    const bridgeModule = Option.isSome(settings) ? bridgeModuleOf(settings.value, path) : undefined;
    if (!bridgeModule)
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "not-configured", message: "The Rubato provider is not configured on this Mac." } },
        { status: 503 },
      );
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const response = yield* Effect.tryPromise(async () =>
      (await loadBridge(bridgeModule)).handleCacheWarmingRequest(webRequest),
    ).pipe(
      Effect.orElseSucceed(() =>
        Response.json(
          { error: { code: "failed", message: "The Rubato bridge failed to load." } },
          { status: 500 },
        ),
      ),
    );
    return HttpServerResponse.fromWeb(response);
  });
}
