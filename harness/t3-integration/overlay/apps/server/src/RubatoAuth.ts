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

// Settings > Providers. The work happens in the Rubato checkout's auth service,
// found next to the bridge module the Rubato provider is wired to: the checkout
// that runs the sessions is the one whose `rubato auth` owns their credentials.
// This route only authenticates and hands the request over.
interface AuthModule {
  authService(): unknown;
  handleAuthRequest(service: unknown, request: Request): Promise<Response>;
}
const modules = new Map<string, Promise<AuthModule>>();

function loadAuthModule(file: string): Promise<AuthModule> {
  let loaded = modules.get(file);
  if (!loaded) {
    loaded = import(/* @vite-ignore */ pathToFileURL(file).href).then((module: unknown) => {
      if (
        !module ||
        typeof module !== "object" ||
        !("authService" in module) ||
        !("handleAuthRequest" in module)
      )
        throw new Error("Invalid Rubato auth module");
      return module as AuthModule;
    });
    loaded.catch(() => modules.delete(file));
    modules.set(file, loaded);
  }
  return loaded;
}

export const rubatoAuthRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    return HttpRouter.add("*", "/rubato/auth/*", handle(auth, serverSettings, path));
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
            code: "auth-not-configured",
            message: "The Rubato provider is not configured on this Mac.",
          },
        },
        { status: 503 },
      );
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const response = yield* Effect.tryPromise(async () => {
      const module = await loadAuthModule(path.join(path.dirname(bridgeModule), "auth", "service.mjs"));
      return module.handleAuthRequest(module.authService(), webRequest);
    }).pipe(
      Effect.orElseSucceed(() =>
        Response.json(
          { error: { code: "auth-failed", message: "The Rubato auth service failed to load." } },
          { status: 500 },
        ),
      ),
    );
    return HttpServerResponse.fromWeb(response);
  });
}
