import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  OrchestrationV2Command,
  ProjectId,
  ThreadId,
  type AuthSessionId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
import * as SqlClient from "effect/sql/SqlClient";
import { RubatoThreadImporter, nextTurnItemOrdinal } from "./provider/RubatoThreadImporter.ts";
import { ProjectStoreV2 } from "./orchestration-v2/ProjectStore.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { bridgeModuleOf } from "./RubatoMemory.ts";
import { authorized } from "./RubatoServiceRoute.ts";

// The Mac's voice service (`/rubato/voice/*`, harness/t3-integration/voice-input.md).
// The work lives in the Rubato checkout's voice module, found next to the bridge
// module the Rubato provider runs, so each Mac loads its own checkout. This file
// authenticates, hands requests over, and gives that module T3's orchestrator in
// plain shapes. The module reads voice.json itself whenever it changes.
interface VoiceRuntime {
  noteActivity(input: unknown): void;
  noteSubscription(input: unknown): () => void;
  acceptsToken(header: string | undefined): boolean;
  handle(request: Request, desktopAuthenticated: boolean): Promise<Response>;
  /** Settings › Chat › Voice input. Absent in a checkout older than the settings page. */
  handleSettings?(request: Request): Promise<Response>;
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
    // Where a queued voice message is now: its run's status, or null once T3 no longer has it.
    readRun: (threadId: string, runId: string) => Effect.runPromise(Effect.gen(function* () {
      const id = ThreadId.make(threadId);
      const shell = yield* orchestrator.getThreadShell(id).pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return null;
      const records = yield* orchestrator.getThreadRecords(id, ["runs"]);
      return records.runs.find((run) => run.id === runId)?.status ?? null;
    })),
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

  const { dispatch, readThread, readRun, listThreads } = voiceOrchestrator(orchestrator);
  // The voice notices (queued, sent, cancelled, failed, expired) as rows in the thread.
  // Required, not optional: a layer without them would skip every notice without a word.
  const importer = yield* RubatoThreadImporter;
  const sql = yield* SqlClient.SqlClient;
  const appendNotice = (notice: { readonly threadId: string; readonly id: string; readonly message: string }) =>
    Effect.runPromise(Effect.gen(function* () {
      const threadId = ThreadId.make(notice.threadId);
      const ordinal = yield* nextTurnItemOrdinal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* importer.appendNotice({ threadId, id: notice.id, message: notice.message, ordinal });
    }));
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

  const statePath = path.join(path.dirname(configPath), "voice-state.json");
  const runtimeOptions = {
    configPath,
    statePath,
    environmentId: environment.environmentId,
    dispatch, readThread, readRun, appendNotice, readProject, listThreads,
  };

  // The checkout's voice module: next to the Rubato provider's bridge module. A
  // voice.json written before that names the module itself.
  const locateModule = async (): Promise<string | undefined> => {
    const settings = await Effect.runPromise(serverSettings.getSettings.pipe(Effect.option));
    const bridge = Option.isSome(settings) ? bridgeModuleOf(settings.value, path) : undefined;
    if (bridge) return path.join(path.dirname(bridge), "voice", "runtime.mjs");
    const legacy = await Effect.runPromise(fs.readFileString(configPath).pipe(
      Effect.map((text) => (JSON.parse(text) as { module?: unknown }).module),
      Effect.orElseSucceed(() => undefined),
    ));
    return typeof legacy === "string" && path.isAbsolute(legacy) ? legacy : undefined;
  };

  // Loaded once; a failed load (no provider yet, a broken checkout) is tried again on the next request.
  let loading: Promise<VoiceRuntime | undefined> | undefined;
  const loadRuntime = (): Promise<VoiceRuntime | undefined> => {
    loading ??= (async () => {
      const file = await locateModule();
      if (!file) return undefined;
      const module: unknown = await import(/* @vite-ignore */ pathToFileURL(file).href);
      if (!module || typeof module !== "object" || !("createVoiceRuntime" in module) ||
          typeof module.createVoiceRuntime !== "function") throw new Error(`Invalid voice module: ${file}`);
      const runtime = (module.createVoiceRuntime as (options: typeof runtimeOptions) => VoiceRuntime)(runtimeOptions);
      voice = runtime;
      // Sends claims a restart interrupted. T3 queues new sends itself, so nothing waits here.
      void Effect.runPromise(startup.awaitCommandReady).then(() => runtime.wake()).catch(() => {});
      return runtime;
    })().then(
      (runtime) => {
        if (!runtime) loading = undefined;
        return runtime;
      },
      (cause: unknown) => {
        loading = undefined;
        void Effect.runPromise(Effect.logWarning("Rubato Voice could not load the checkout's voice module", cause));
        return undefined;
      },
    );
    return loading;
  };
  // Load at start, so a phone's presence counts before the first recording.
  yield* startup.awaitCommandReady.pipe(
    Effect.andThen(Effect.promise(loadRuntime)),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    const runtime = voice;
    voice = undefined;
    await runtime?.close();
  }));

  const unavailable = (code: string) => HttpServerResponse.jsonUnsafe({ error: { code } }, { status: 503 });
  return HttpRouter.add("*", "/rubato/voice/*", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const runtime = yield* Effect.promise(loadRuntime);
    const webRequest = yield* HttpServerRequest.toWeb(request);
    // Settings: this Mac's signed-in window only, never the phone's voice token.
    if (new URL(webRequest.url).pathname.startsWith("/rubato/voice/settings/")) {
      if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
      const handleSettings = runtime?.handleSettings;
      if (!runtime || !handleSettings) return unavailable("voice-unavailable");
      const response = yield* Effect.tryPromise(() => handleSettings(webRequest)).pipe(
        Effect.orElseSucceed(() => Response.json({ error: { code: "voice-settings-failed" } }, { status: 500 })),
      );
      return HttpServerResponse.fromWeb(response);
    }
    if (!runtime) return unavailable("voice-not-configured");
    let desktopAuthenticated = false;
    if (!runtime.acceptsToken(request.headers.authorization)) {
      desktopAuthenticated = yield* authorized(auth, request);
      if (!desktopAuthenticated) return HttpServerResponse.empty({ status: 401 });
    }
    const response = yield* Effect.tryPromise(() => runtime.handle(webRequest, desktopAuthenticated)).pipe(
      Effect.orElseSucceed(() => Response.json({ error: { code: "voice-failed" } }, { status: 500 })),
    );
    return HttpServerResponse.fromWeb(response);
  }));
}));
