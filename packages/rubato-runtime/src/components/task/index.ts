import { loadSenpiRubatoConfig } from "../config-resolution"
import {
  buildLeadTeamTools,
  createLeadDeliveryJournal,
  createTaskCancelTool,
  createTaskSendTool,
  createTaskTool,
  liveModelCatalog,
  defaultResolveCallerSessionId,
  isTeamMemberProcess,
  resolveTeamRuntimeDirs,
  teamStorageBaseDir,
  toTeamCoreConfig,
  type LeadDeliveryJournal,
  type SkillLoader,
  type TeamToolsService,
} from "@rubato/task"

import type { ComponentContext, RubatoComponent, SenpiExtensionAPI } from "../../extension/types"
import { registerTaskCommands } from "./commands"
import { composeTaskEngine, type TaskEngine, type TaskRunnerFactories } from "./engine"
import { TASK_USAGE_HINT_FLAG, wireEventBridge } from "./event-bridge"
import { createLeadPollerLifecycle, type LeadPollerLifecycle } from "./lead-poller-lifecycle"
import { TEAM_MEMBER_LIVENESS_MESSAGE_TYPE } from "./member-liveness"
import { TASK_COMPLETION_MESSAGE_TYPE } from "./parent-notifier"
import { renderTaskCompletion, renderTeamMemberLiveness } from "./renderers"
import { createResumptionChannelEmitter } from "./resumption-channel-emitter"
import { createTeamMailboxReconciler, createTeamService } from "./team-service"
import { createSessionTransitionBridge } from "./session-transition-bridge"
import { createRuntimeTeamBatchWake } from "./team-batch-wake"
import { wireSessionStartProcessSweep } from "./process-sweep"
import { createTaskStatusUi } from "./status-ui"
import { missingTaskCapabilities } from "./surface"
import { createTaskSkillLoader } from "./task-skill-loader"

const TASK_ENABLED_FLAG = "rubato-task"

export { wireEventBridge } from "./event-bridge"

export interface TaskComponentOptions {
  // Project root the task engine anchors its state dir + rubato.json load to. Defaults to the cwd the
  // host reports for THIS session; injectable so tests never write task state into the repo tree.
  readonly loadConfig?: typeof loadSenpiRubatoConfig
  readonly loadSkills?: SkillLoader
  readonly resolveCwd?: () => string
  /** Explicit child runner factories (stock Pi adapter); omitted for legacy Senpi defaults. */
  readonly runnerFactories?: TaskRunnerFactories
}

export function createTaskComponent(options: TaskComponentOptions = {}): RubatoComponent {
  const loadConfig = options.loadConfig ?? loadSenpiRubatoConfig
  return {
    name: "task",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const memberProcess = isTeamMemberProcess()

      // Unconditional Rubato process hygiene (T16): fires on session_start before any
      // flag/capability gate can skip the rest of the component.
      wireSessionStartProcessSweep(pi, ctx)

      registerTaskFlags(pi)
      if (pi.getFlag(TASK_ENABLED_FLAG) === false) {
        ctx.logger.info("Rubato task component disabled by flag")
        return
      }

      const missing = missingTaskCapabilities(pi)
      if (missing.length > 0) {
        ctx.logger.warn("Rubato task component skipped: missing ExtensionAPI capabilities", { missing })
        return
      }

      const cwd = options.resolveCwd?.() ?? sessionCwd(pi)
      const loaded = loadConfig({ cwd })
      const loadSkills = options.loadSkills ?? createTaskSkillLoader()

      const engine = composeTaskEngine({
        pi,
        rubatoConfig: loaded.config,
        cwd,
        loadSkills,
        sharedParentTools: () => ctx.getCapturedTools?.() ?? [],
        ...(ctx.idleCoordinator !== undefined && { coordinator: ctx.idleCoordinator }),
        ...(options.runnerFactories === undefined ? {} : { runnerFactories: options.runnerFactories }),
      })

      pi.registerMessageRenderer?.(TASK_COMPLETION_MESSAGE_TYPE, renderTaskCompletion)
      pi.registerMessageRenderer?.(TEAM_MEMBER_LIVENESS_MESSAGE_TYPE, renderTeamMemberLiveness)
      const models = liveModelCatalog(() => engine.runtime.modelRegistry())
      const teamTools = createTeamToolContext(pi, ctx, engine, models)
      registerTaskTools(pi, engine, models)
      if (!memberProcess) {
        registerTeamTools(pi, teamTools)
        registerRemovedTeamWaitHint(pi)
      }
      registerTaskCommands(pi, engine.manager)

      const statusUi = createTaskStatusUi({
        manager: engine.manager,
        runtime: engine.runtime,
        terminalWidth: () => process.stdout.columns,
      })
      const resumptionChannels = createResumptionChannelEmitter({
        pi,
        manager: engine.manager,
        sessionId: () => engine.runtime.sessionId(),
        stateDir: {
          project_dir: cwd,
          ...(engine.settings.state_dir !== undefined ? { task: { state_dir: engine.settings.state_dir } } : {}),
        },
        settings: engine.settings,
      })
      engine.onStoreMutation(() => {
        statusUi.scheduleSync()
        void resumptionChannels.emitIfChanged().catch((error: unknown) => {
          ctx.logger.warn("Rubato task resumption-channel emission failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })
      const transitions = createSessionTransitionBridge({ runtime: engine.runtime, notifier: engine.notifier })

      const teamBatchWake = createRuntimeTeamBatchWake({
        engine,
        listTeams: teamTools.service.listTeams,
        config: toTeamCoreConfig(engine.settings, teamStorageBaseDir({
          project_dir: cwd,
          ...(engine.settings.state_dir !== undefined ? { task: { state_dir: engine.settings.state_dir } } : {}),
        })),
        stateDir: {
          project_dir: cwd,
          ...(engine.settings.state_dir !== undefined ? { task: { state_dir: engine.settings.state_dir } } : {}),
        },
        sessionId: () => engine.runtime.sessionId(),
        onError: (error) => {
          ctx.logger.warn("Rubato task team batch wake failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        },
      })
      if (!memberProcess) {
        // Two edges can newly make "the batch is finished" true: a task-record write (member turn
        // ends) and a mailbox/board change with no record write. The second has no other signal, so
        // the existing 1s poller tick drives it; both funnel through the wake's own serialization.
        engine.onStoreMutation(() => teamBatchWake.schedule())
        teamTools.leadPollers.onTick(() => teamBatchWake.schedule())
      }

      wireEventBridge(pi, ctx, engine, statusUi, transitions, {
        reconcileTeamMailbox: teamTools.reconcileTeamMailbox,
        leadPollers: teamTools.leadPollers,
        resumptionChannels,
        teamBatchWake,
      })
    },
  }
}

// senpi loads one extension instance per session and builds its ExtensionAPI with that session's
// cwd. A multi-session host keeps every session in ONE process, so process.cwd() is the process
// launch directory: anchoring there collapses every session's task state into a single store and
// hides child artifacts from the host's per-project readers. It remains the fallback only for
// hosts that predate `cwd` on the extension API.
function sessionCwd(pi: SenpiExtensionAPI): string {
  return typeof pi.cwd === "string" && pi.cwd.length > 0 ? pi.cwd : process.cwd()
}

function registerRemovedTeamWaitHint(pi: SenpiExtensionAPI): void {
  pi.registerRemovedToolHint?.(
    "team_wait",
    "team_wait was removed - team messages arrive as steered notifications; send updates with team_send and end your turn.",
  )
}

function registerTaskFlags(pi: SenpiExtensionAPI): void {
  pi.registerFlag(TASK_ENABLED_FLAG, {
    type: "boolean",
    default: true,
    description: "Enable the Rubato task engine (use --no-rubato-task to disable).",
  })
  pi.registerFlag(TASK_USAGE_HINT_FLAG, {
    type: "boolean",
    default: true,
    description: "Inject Rubato task usage guidance once per session.",
  })
}

// senpi-task tool factories return fully-typed ToolDefinitions whose typed renderCall breaks a plain
// structural assignment to the registerTool(Record) seam; spreading each into a fresh object literal
// lands it through the record-shaped registration boundary without a cast (no behavioural change).
function registerTaskTools(
  pi: SenpiExtensionAPI,
  engine: TaskEngine,
  models: ReturnType<typeof liveModelCatalog>,
): void {
  const resolveCallerSessionId = defaultResolveCallerSessionId
  const manager = engine.manager
  pi.registerTool({
    ...createTaskTool({
      manager,
      rubatoConfig: engine.rubatoConfig,
      agents: engine.agents,
      models,
    }),
  })
  pi.registerTool({
    ...createTaskSendTool({
      manager,
      resolveCallerSessionId,
    }),
  })
  pi.registerTool({ ...createTaskCancelTool({ manager }) })
  // AgentOutput is gone from the model surface. A delegated result arrives as a completion pointer
  // plus a result file path; peeking a child's transcript was how the lead's context filled up with
  // execution logs, and the runtime's own diagnostics (status UI, /tasks, run logs) stay available to
  // the human. Nothing internal depends on the tool being registered.
}

function createTeamToolContext(
  pi: SenpiExtensionAPI,
  ctx: ComponentContext,
  engine: TaskEngine,
  models: ReturnType<typeof liveModelCatalog>,
): TeamToolContext {
  const serviceDeps = {
    manager: engine.manager,
    destruction: engine.lifecycle,
    runtime: engine.runtime,
    settings: engine.settings,
    rubatoConfig: engine.rubatoConfig,
    models,
    cwd: engine.runtime.cwd(),
  }
  const service = createTeamService(serviceDeps)
  const stateDir = {
    project_dir: serviceDeps.cwd,
    ...(engine.settings.state_dir !== undefined ? { task: { state_dir: engine.settings.state_dir } } : {}),
  }
  const deliveryJournal = createLeadDeliveryJournal()
  const leadPollers = createLeadPollerLifecycle({
    listTeams: service.listTeams,
    runtime: engine.runtime,
    config: toTeamCoreConfig(engine.settings, teamStorageBaseDir(stateDir)),
    runtimeDir: (teamRunId) => resolveTeamRuntimeDirs(stateDir, teamRunId).runtimeDir,
    deliveryJournal,
    appendTaskEvent: engine.appendTaskEvent,
    pi,
    logger: ctx.logger,
    ...(ctx.idleCoordinator !== undefined ? { coordinator: ctx.idleCoordinator } : {}),
  })
  return { service, models, reconcileTeamMailbox: createTeamMailboxReconciler(serviceDeps), deliveryJournal, leadPollers }
}

type TeamToolContext = {
  readonly service: TeamToolsService
  readonly models: ReturnType<typeof liveModelCatalog>
  readonly reconcileTeamMailbox: () => Promise<void>
  readonly deliveryJournal: LeadDeliveryJournal
  readonly leadPollers: LeadPollerLifecycle
}

function registerTeamTools(pi: SenpiExtensionAPI, context: TeamToolContext): void {
  for (const tool of buildLeadTeamTools({ service: context.service, models: context.models })) pi.registerTool({ ...tool })
}
