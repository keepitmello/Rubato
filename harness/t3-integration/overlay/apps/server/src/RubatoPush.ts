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
import { bridgeModuleOf, tryBridge } from "./RubatoMemory.ts";
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

/** The finishing run's timing, failure reason and whether the person opened it in T3. */
interface RunFacts {
  readonly startedAt: string | null;
  readonly requestedAt: string | null;
  readonly lastError: string | null;
  readonly openedByPerson: boolean;
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
      return yield* tryBridge("push module", () => loaded!.module).pipe(Effect.orElseSucceed(() => null));
    });

    const personOpened = Effect.fn("RubatoPush.personOpened")(function* (threadId: ThreadId, runId: NonNullable<OrchestrationV2ThreadShell["latestRunId"]>) {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
      const openingMessageId = runs[0]?.userMessageId;
      if (!openingMessageId) return false;
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], { messageIds: [openingMessageId] });
      return messages[0]?.role === "user" && messages[0].createdBy === "user";
    });

    const stateOf = Effect.fn("RubatoPush.stateOf")(function* (environmentId: EnvironmentId, threadId: ThreadId) {
      const thread: OrchestrationV2ThreadShell | null = yield* threads.getThreadShell(threadId);
      if (thread === null || thread.archivedAt !== null) return { state: null, run: null };
      const project: Option.Option<Project> = yield* projects.getById(thread.projectId);
      if (Option.isNone(project)) return { state: null, run: null };
      const state = projectThreadAwarenessV2({ environmentId, project: project.value, thread });
      const terminal = state?.phase === "completed" || state?.phase === "failed";
      if (!terminal) return { state, run: null };
      const startedAt = thread.latestRunStartedAt ?? null;
      const requestedAt = thread.latestRunRequestedAt ?? null;
      // T3 may mark a run started just before Pi writes the person's prompt. Read the
      // run's opening message rather than mistaking the previous transcript opener for it.
      const openedByPerson = thread.latestRunId === null ? false
        : yield* personOpened(threadId, thread.latestRunId).pipe(Effect.orElseSucceed(() => false));
      return {
        state,
        run: { startedAt: startedAt === null ? null : DateTime.formatIso(startedAt),
          requestedAt: requestedAt === null ? null : DateTime.formatIso(requestedAt),
          lastError: thread.lastError ?? null, openedByPerson },
      };
    });

    const publish = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const module = yield* pushModule;
        if (module === null) return;
        const environmentId = yield* environment.getEnvironmentId;
        const { state, run } = yield* stateOf(environmentId, threadId);
        yield* tryBridge("push thread alert", () => module.pushService().threadChanged(threadId, state, run));
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
