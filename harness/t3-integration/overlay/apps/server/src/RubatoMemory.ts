import { pathToFileURL } from "node:url";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as ServerSettings from "./serverSettings.ts";

// Settings > 기억. The work happens in the Rubato checkout's memory service,
// found next to the bridge module the Rubato provider is wired to: the same
// checkout that runs the sessions answers for their memory. This route only
// authenticates and hands the request over.
interface MemoryModule {
  memoryService(): unknown;
  handleMemoryRequest(service: unknown, request: Request): Promise<Response>;
}
const modules = new Map<string, Promise<MemoryModule>>();

function bridgeModuleOf(
  settings: { readonly providerInstances?: unknown },
  path: Path.Path,
): string | undefined {
  const instances = settings.providerInstances;
  if (!instances || typeof instances !== "object") return undefined;
  for (const instance of Object.values(instances as Record<string, unknown>)) {
    if (!instance || typeof instance !== "object") continue;
    const { driver, config } = instance as { driver?: unknown; config?: unknown };
    if (driver !== "rubato-pi" || !config || typeof config !== "object") continue;
    const bridge = (config as { bridgeModule?: unknown }).bridgeModule;
    if (typeof bridge === "string" && path.isAbsolute(bridge)) return bridge;
  }
  return undefined;
}

function loadMemoryModule(file: string): Promise<MemoryModule> {
  let loaded = modules.get(file);
  if (!loaded) {
    loaded = import(/* @vite-ignore */ pathToFileURL(file).href).then((module: unknown) => {
      if (
        !module ||
        typeof module !== "object" ||
        !("memoryService" in module) ||
        !("handleMemoryRequest" in module)
      )
        throw new Error("Invalid Rubato memory module");
      return module as MemoryModule;
    });
    loaded.catch(() => modules.delete(file));
    modules.set(file, loaded);
  }
  return loaded;
}

export const rubatoMemoryRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    return HttpRouter.add("*", "/rubato/memory/*", handle(auth, serverSettings, path));
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
        {
          error: {
            code: "memory-not-configured",
            message: "The Rubato provider is not configured on this Mac.",
          },
        },
        { status: 503 },
      );
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const response = yield* Effect.tryPromise(async () => {
      const module = await loadMemoryModule(
        path.join(path.dirname(bridgeModule), "memory", "service.mjs"),
      );
      return module.handleMemoryRequest(module.memoryService(), webRequest);
    }).pipe(
      Effect.orElseSucceed(() =>
        Response.json(
          { error: { code: "memory-failed", message: "The Rubato memory service failed to load." } },
          { status: 500 },
        ),
      ),
    );
    return HttpServerResponse.fromWeb(response);
  });
}
