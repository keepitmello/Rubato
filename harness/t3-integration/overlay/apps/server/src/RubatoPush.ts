import { pathToFileURL } from "node:url";
import type { EnvironmentId, OrchestrationV2ThreadShell, Project, ThreadId } from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "./auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { shouldPublishAgentAwarenessEvent } from "./relay/AgentAwarenessRelay.ts";
import { bridgeModuleOf } from "./RubatoMemory.ts";
import { answerFromService, authorized, type ServiceSpec } from "./RubatoServiceRoute.ts";
import * as ServerSettings from "./serverSettings.ts";

// Phone notifications through the Rubato relay (push-edits.mjs). The route lets the Rubato app on a
// phone hand this Mac its push grant; the feed hands every thread's awareness state, the one T3's
// relay publisher computes, to src/push/service.mjs in the Rubato checkout, which decides what
// becomes an alert and sends it, and what the phone's Live Activity card shows. On start the server
// hands it every thread already at work, so the card is whole before the next event. T3's own relay
// publisher is untouched and keeps serving the T3 app.

const spec: ServiceSpec = {
  route: "/rubato/push",
  file: "push/service.mjs",
  service: "pushService",
  handler: "handlePushRequest",
  name: "push",
};

interface PushModule {
  readonly pushService: () => {
    readonly threadChanged: (threadId: string, state: AgentAwarenessState | null, run: RunFacts | null) => Promise<unknown>;
    readonly threadSeen: (threadId: string, state: AgentAwarenessState) => void;
  };
}

/** What a finish alert says of the run beyond the awareness state: how long it took, why it failed. */
interface RunFacts {
  readonly startedAt: string | null;
  readonly lastError: string | null;
}

export const rubatoPushLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const environment = yield* ServerEnvironment.ServerEnvironment;

    let loaded: { readonly file: string; readonly module: Promise<PushModule> } | null = null;
    const pushModule = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      const bridge = Option.isSome(settings) ? bridgeModuleOf(settings.value, path) : undefined;
      if (!bridge) return null;
      const file = path.join(path.dirname(bridge), spec.file);
      if (loaded?.file !== file) {
        const module = import(/* @vite-ignore */ pathToFileURL(file).href) as Promise<PushModule>;
        loaded = { file, module };
        module.catch(() => { if (loaded?.file === file) loaded = null; });
      }
      return yield* Effect.tryPromise(() => loaded!.module).pipe(Effect.orElseSucceed(() => null));
    });

    const stateOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread: OrchestrationV2ThreadShell | null = yield* threads.getThreadShell(threadId);
        if (thread === null || thread.archivedAt !== null) return { state: null, run: null };
        const project: Option.Option<Project> = yield* projects.getById(thread.projectId);
        if (Option.isNone(project)) return { state: null, run: null };
        const startedAt = thread.activityRunStartedAt ?? thread.latestRunStartedAt ?? null;
        return {
          state: projectThreadAwarenessV2({ environmentId, project: project.value, thread }),
          run: { startedAt: startedAt === null ? null : DateTime.formatIso(startedAt), lastError: thread.lastError ?? null },
        };
      });

    const publish = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const module = yield* pushModule;
        if (module === null) return;
        const environmentId = yield* environment.getEnvironmentId;
        const { state, run } = yield* stateOf(environmentId, threadId);
        yield* Effect.tryPromise(() => module.pushService().threadChanged(threadId, state, run));
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Rubato push: thread alert not sent", { threadId, cause })));

    // Threads already at work when the server starts: the card shows them, without an alert.
    const seed = Effect.gen(function* () {
      const module = yield* pushModule;
      if (module === null) return;
      const environmentId = yield* environment.getEnvironmentId;
      const [projectSnapshot, shellSnapshot] = yield* Effect.all([projects.snapshot, threads.getShellSnapshot()]);
      const projectById = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
      for (const thread of shellSnapshot.threads) {
        const project = projectById.get(thread.projectId);
        if (!project || thread.archivedAt !== null) continue;
        const state = projectThreadAwarenessV2({ environmentId, project, thread });
        if (state !== null && state.phase !== "completed" && state.phase !== "failed") module.pushService().threadSeen(thread.id, state);
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Rubato push: running threads not read for the Live Activity", { cause })));
    yield* Effect.forkScoped(seed);

    yield* Effect.forkScoped(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        shouldPublishAgentAwarenessEvent(event) ? publish(event.threadId) : Effect.void,
      ),
    );

    return HttpRouter.add(
      "*",
      `${spec.route}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* authorized(auth, request))) return HttpServerResponse.empty({ status: 401 });
        return yield* answerFromService(spec, serverSettings, path, request);
      }),
    );
  }),
);
