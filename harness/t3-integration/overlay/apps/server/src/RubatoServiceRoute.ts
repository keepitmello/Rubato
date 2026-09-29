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

// Settings pages that talk to the Rubato checkout: Providers (`rubato auth`),
// About (version, update check, restart) and Scheduled Tasks (RubatoSchedule.ts). The work happens in a module found
// next to the bridge module the Rubato provider is wired to: the checkout that
// runs the sessions answers for them. A route only authenticates and hands the
// request over.
export interface ServiceSpec {
  /** Route prefix, e.g. "/rubato/auth". */
  readonly route: `/${string}`;
  /** Module path relative to the bridge module's directory. */
  readonly file: string;
  /** Export that returns the shared service instance. */
  readonly service: string;
  /** Export that answers one web Request. */
  readonly handler: string;
  /** Word for error messages: "auth", "app". */
  readonly name: string;
}

type ServiceModule = Record<string, unknown>;
const modules = new Map<string, Promise<ServiceModule>>();

function loadModule(file: string, spec: ServiceSpec): Promise<ServiceModule> {
  let loaded = modules.get(file);
  if (!loaded) {
    loaded = import(/* @vite-ignore */ pathToFileURL(file).href).then((module: unknown) => {
      if (
        !module ||
        typeof module !== "object" ||
        typeof (module as ServiceModule)[spec.service] !== "function" ||
        typeof (module as ServiceModule)[spec.handler] !== "function"
      )
        throw new Error(`Invalid Rubato ${spec.name} module`);
      return module as ServiceModule;
    });
    loaded.catch(() => modules.delete(file));
    modules.set(file, loaded);
  }
  return loaded;
}

function serviceRouteLayer(spec: ServiceSpec) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      return HttpRouter.add("*", `${spec.route}/*`, handle(spec, auth, serverSettings, path));
    }),
  );
}

function handle(
  spec: ServiceSpec,
  auth: EnvironmentAuth["Service"],
  serverSettings: ServerSettings.ServerSettingsService["Service"],
  path: Path.Path,
) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
    return yield* answerFromService(spec, serverSettings, path, request);
  });
}

/** Whether the request carries a session allowed to operate this environment. */
export function authorized(auth: EnvironmentAuth["Service"], request: HttpServerRequest.HttpServerRequest) {
  return auth.authenticateHttpRequest(request).pipe(
    Effect.option,
    Effect.map((session) => Option.isSome(session) && session.value.scopes.includes(AuthOrchestrationOperateScope)),
  );
}

/** Hands an authenticated request to the spec's module in the Rubato checkout. */
export function answerFromService(
  spec: ServiceSpec,
  serverSettings: ServerSettings.ServerSettingsService["Service"],
  path: Path.Path,
  request: HttpServerRequest.HttpServerRequest,
) {
  return Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    const bridgeModule = Option.isSome(settings) ? bridgeModuleOf(settings.value, path) : undefined;
    if (!bridgeModule)
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            code: `${spec.name}-not-configured`,
            message: "The Rubato provider is not configured on this Mac.",
          },
        },
        { status: 503 },
      );
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const response = yield* Effect.tryPromise(async () => {
      const module = await loadModule(path.join(path.dirname(bridgeModule), spec.file), spec);
      const service = (module[spec.service] as () => unknown)();
      return (module[spec.handler] as (service: unknown, request: Request) => Promise<Response>)(
        service,
        webRequest,
      );
    }).pipe(
      Effect.orElseSucceed(() =>
        Response.json(
          {
            error: {
              code: `${spec.name}-failed`,
              message: `The Rubato ${spec.name} service failed to load.`,
            },
          },
          { status: 500 },
        ),
      ),
    );
    return HttpServerResponse.fromWeb(response);
  });
}

export const rubatoAuthRouteLayer = serviceRouteLayer({
  route: "/rubato/auth",
  file: "auth/service.mjs",
  service: "authService",
  handler: "handleAuthRequest",
  name: "auth",
});

export const rubatoAppRouteLayer = serviceRouteLayer({
  route: "/rubato/app",
  file: "app/service.mjs",
  service: "appService",
  handler: "handleAppRequest",
  name: "app",
});
