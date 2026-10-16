import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  AuthOrchestrationOperateScope,
  OrchestrationV2Command,
  ProjectId,
  ThreadId,
  type AuthSessionId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "./orchestration-v2/ProjectStore.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { ServerSettingsService } from "./serverSettings.ts";

// The Mac's voice service (`/rubato/voice/*`, harness/t3-integration/voice-input.md).
// The work lives in the private module voice.json names; this file authenticates,
// hands requests over, and gives that module T3's orchestrator in plain shapes.
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
/** Counts one thread subscription as presence for as long as the stream's scope lives. */
export const noteVoiceSubscription = (input: {
  readonly sessionId: AuthSessionId;
  readonly rpcClientId: string | number;
  readonly threadId: ThreadId;
}) =>
  Effect.acquireRelease(
    Effect.sync(() => voice?.noteSubscription(input) ?? (() => {})),
    (release) => Effect.sync(release),
  );

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

/** A run the dispatched command created or changed, as the voice module reads it. */
interface VoiceRun {
  readonly id: string;
  readonly status: string;
  readonly userMessageId: string;
}

/**
 * T3's orchestrator in the promise shapes the voice module calls. A command is
 * decoded against the V2 command schema first, so a malformed one fails here
 * instead of inside the orchestrator.
 */
export function voiceOrchestrator(orchestrator: OrchestratorV2["Service"]) {
  return {
    dispatch: (command: unknown) => Effect.runPromise(
      Schema.decodeUnknownEffect(OrchestrationV2Command)(command).pipe(
        Effect.flatMap(orchestrator.dispatch),
        Effect.map((result) => ({
          runs: result.storedEvents.flatMap(({ event }): VoiceRun[] =>
            event.type === "run.created" || event.type === "run.updated"
              ? [{ id: event.payload.id, status: event.payload.status, userMessageId: event.payload.userMessageId }]
              : []),
        })),
      ),
    ),
    readThread: (id: string) => Effect.runPromise(
      orchestrator.getThreadShell(ThreadId.make(id)).pipe(Effect.orElseSucceed(() => null)),
    ),
    listThreads: () => Effect.runPromise(
      orchestrator.getShellSnapshot().pipe(Effect.map((snapshot) => snapshot.threads)),
    ),
  };
}

export const rubatoVoiceRouteLayer = Layer.unwrap(Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectStoreV2;
  const serverSettings = yield* ServerSettingsService;
  const auth = yield* EnvironmentAuth;
  const environment = yield* (yield* ServerEnvironment).getDescriptor;
  const startup = yield* ServerRuntimeStartup;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = process.env.RUBATO_VOICE_CONFIG ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".rubato", "voice.json");

  const { dispatch, readThread, listThreads } = voiceOrchestrator(orchestrator);
  // The model and permission mode a new thread starts with, resolved the way the
  // apps resolve them: the project's override, else this environment's default.
  const readProject = (id: string) => Effect.runPromise(Effect.gen(function* () {
    const projectId = ProjectId.make(id);
    const project = yield* projects.getShell(projectId);
    if (Option.isNone(project)) return null;
    const settings = yield* serverSettings.getSettings;
    const resolved = resolveProjectSettings(settings, projectId, project.value).settings;
    return {
      id: project.value.id,
      title: project.value.title,
      defaultModelSelection: resolved.defaultModelSelection,
      defaultRuntimeMode: resolved.defaultRuntimeMode,
    };
  }).pipe(Effect.orElseSucceed(() => null)));

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
      dispatch(command: unknown): Promise<{ readonly runs: ReadonlyArray<VoiceRun> }>;
      readThread(id: string): Promise<unknown>;
      readProject(id: string): Promise<unknown>;
      listThreads(): Promise<ReadonlyArray<unknown>>;
    }) => VoiceRuntime;
    return yield* Effect.try(() => factory({
      config, statePath: path.join(path.dirname(configPath), "voice-state.json"),
      environmentId: environment.environmentId,
      dispatch, readThread, readProject, listThreads,
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
    // Sends claims a restart interrupted. T3 queues new sends itself, so nothing waits here.
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
