import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { AuthOrchestrationOperateScope, OrchestrationCommand, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";

interface VoiceRuntime {
  noteActivity(input: unknown): void;
  noteSubscription(input: unknown): () => void;
  acceptsToken(header: string | undefined): boolean;
  handle(request: Request, desktopAuthenticated: boolean): Promise<Response>;
  wake(): Promise<void>;
  close(): Promise<void>;
}
let voice: VoiceRuntime | undefined;
export const noteVoiceActivity = (input: unknown) => voice?.noteActivity(input);
export const noteVoiceSubscription = (input: unknown) => voice?.noteSubscription(input) ?? (() => {});

const VoiceConfig = Schema.Struct({
  module: Schema.String,
  token: Schema.String,
  model: Schema.String,
  defaultProjectId: Schema.optional(Schema.String),
  openaiApiKey: Schema.optional(Schema.String),
});
class VoiceConfigurationError extends Data.TaggedError("VoiceConfigurationError")<{
  readonly message: string;
}> {}

export const rubatoVoiceRouteLayer = Layer.unwrap(Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const auth = yield* EnvironmentAuth;
  const environment = yield* (yield* ServerEnvironment).getDescriptor;
  const startup = yield* ServerRuntimeStartup;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = process.env.RUBATO_VOICE_CONFIG ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".rubato", "voice.json");
  const initialized = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(configPath))) return undefined;
    const config = yield* fs.readFileString(configPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceConfig))),
    );
    if (!path.isAbsolute(config.module)) return yield* new VoiceConfigurationError({ message: "Voice module path must be absolute" });
    const module: unknown = yield* Effect.tryPromise(() => import(/* @vite-ignore */ pathToFileURL(config.module).href));
    if (!module || typeof module !== "object" || !("createVoiceRuntime" in module) ||
        typeof module.createVoiceRuntime !== "function") return yield* new VoiceConfigurationError({ message: "Invalid voice module" });
    const factory = module.createVoiceRuntime as (options: {
      config: typeof VoiceConfig.Type;
      statePath: string;
      environmentId: string;
      dispatch(command: unknown): Promise<unknown>;
      readThread(id: string): Promise<unknown>;
      readProject(id: string): Promise<unknown>;
      listThreads(): Promise<ReadonlyArray<unknown>>;
    }) => VoiceRuntime;
    return yield* Effect.try(() => factory({
      config, statePath: path.join(path.dirname(configPath), "voice-state.json"),
      environmentId: environment.environmentId,
      dispatch: (command) => Effect.runPromise(Schema.decodeUnknownEffect(OrchestrationCommand)(command).pipe(
        Effect.flatMap(engine.dispatch),
      )),
      readThread: (id) => Effect.runPromise(query.getThreadShellById(ThreadId.make(id)).pipe(Effect.map(Option.getOrNull))),
      readProject: (id) => Effect.runPromise(query.getProjectShellById(ProjectId.make(id)).pipe(Effect.map(Option.getOrNull))),
      listThreads: () => Effect.runPromise(query.getShellSnapshot().pipe(Effect.map((snapshot) => snapshot.threads))),
    }));
  }).pipe(Effect.catch(() => Effect.logWarning("Rubato Voice disabled: check the private voice.json configuration").pipe(
    Effect.as(undefined),
  )));
  voice = initialized;
  if (initialized) {
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      voice = undefined;
      await initialized.close();
    }));
    yield* startup.awaitCommandReady.pipe(
      Effect.andThen(Stream.runForEach(engine.streamDomainEvents, () =>
        Effect.promise(() => initialized.wake()))),
      Effect.forkScoped,
    );
    yield* startup.awaitCommandReady.pipe(
      Effect.andThen(Effect.promise(() => initialized.wake())),
      Effect.forkScoped,
    );
  }
  return HttpRouter.add("*", "/rubato/voice/*", Effect.gen(function* () {
    if (!initialized) return HttpServerResponse.jsonUnsafe({ error: { code: "voice-not-configured" } }, { status: 503 });
    const request = yield* HttpServerRequest.HttpServerRequest;
    let desktopAuthenticated = false;
    if (!initialized.acceptsToken(request.headers.authorization)) {
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      desktopAuthenticated = Option.isSome(session) && session.value.scopes.includes(AuthOrchestrationOperateScope);
      if (!desktopAuthenticated) return HttpServerResponse.empty({ status: 401 });
    }
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const response = yield* Effect.tryPromise(() => initialized.handle(webRequest, desktopAuthenticated)).pipe(
      Effect.orElseSucceed(() => Response.json({ error: { code: "voice-failed" } }, { status: 500 })),
    );
    return HttpServerResponse.fromWeb(response);
  }));
}));
