import { pathToFileURL } from "node:url";
import type { EnvironmentId, OrchestrationV2ThreadShell, Project, ThreadId } from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
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
// becomes an alert and sends it. T3's own relay publisher is untouched and keeps serving the T3 app.

const spec: ServiceSpec = {
  route: "/rubato/push",
  file: "push/service.mjs",
  service: "pushService",
  handler: "handlePushRequest",
  name: "push",
};

interface PushModule {
  readonly pushService: () => {
    readonly threadChanged: (threadId: string, state: AgentAwarenessState | null) => Promise<unknown>;
  };
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
        if (thread === null || thread.archivedAt !== null) return null;
        const project: Option.Option<Project> = yield* projects.getById(thread.projectId);
        if (Option.isNone(project)) return null;
        return projectThreadAwarenessV2({ environmentId, project: project.value, thread });
      });

    const publish = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const module = yield* pushModule;
        if (module === null) return;
        const environmentId = yield* environment.getEnvironmentId;
        const state = yield* stateOf(environmentId, threadId);
        yield* Effect.tryPromise(() => module.pushService().threadChanged(threadId, state));
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Rubato push: thread alert not sent", { threadId, cause })));

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
