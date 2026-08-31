import { loadSenpiRubatoConfig } from "../config-resolution"
import {
  buildLeadTeamTools,
  createLeadDeliveryJournal,
  createTaskCancelTool,
  createTaskOutputTool,
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
} from "@rubato/senpi-task"

import type { ComponentContext, RubatoComponent, SenpiExtensionAPI } from "../../extension/types"
import { CATEGORY_UNAVAILABLE_MESSAGE_TYPE } from "./category-unavailable-warning"
import { registerTaskCommands } from "./commands"
import { composeTaskEngine, type TaskEngine } from "./engine"
import { TASK_USAGE_HINT_FLAG, wireEventBridge } from "./event-bridge"
import { createLeadPollerLifecycle, type LeadPollerLifecycle } from "./lead-poller-lifecycle"
import { TEAM_MEMBER_LIVENESS_MESSAGE_TYPE } from "./member-liveness"
import { TASK_COMPLETION_MESSAGE_TYPE } from "./parent-notifier"
import { renderCategoryUnavailable, renderTaskCompletion, renderTeamMemberLiveness } from "./renderers"
import { createResumptionChannelEmitter } from "./resumption-channel-emitter"
import { createTeamMailboxReconciler, createTeamService } from "./team-service"
import { createSessionTransitionBridge } from "./session-transition-bridge"
import { createSkillInvocationTracker, type SkillInvocationTracker } from "./skill-invocation-tracker"
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
      })

      pi.registerMessageRenderer?.(TASK_COMPLETION_MESSAGE_TYPE, renderTaskCompletion)
      pi.registerMessageRenderer?.(TEAM_MEMBER_LIVENESS_MESSAGE_TYPE, renderTeamMemberLiveness)
      pi.registerMessageRenderer?.(CATEGORY_UNAVAILABLE_MESSAGE_TYPE, renderCategoryUnavailable)
      const teamTools = createTeamToolContext(pi, ctx, engine)
      const skillInvocations = createSkillInvocationTracker(pi)
      registerTaskTools(pi, engine, skillInvocations)
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

      wireEventBridge(pi, ctx, engine, statusUi, transitions, {
        reconcileTeamMailbox: teamTools.reconcileTeamMailbox,
        leadPollers: teamTools.leadPollers,
        resumptionChannels,
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
  skillInvocations: SkillInvocationTracker,
): void {
  const resolveCallerSessionId = defaultResolveCallerSessionId
  const manager = engine.manager
  pi.registerTool({
    ...createTaskTool({
      manager,
      rubatoConfig: engine.rubatoConfig,
      agents: engine.agents,
      models: liveModelCatalog(() => engine.runtime.modelRegistry()),
      resolveSkillInvocations: (sessionId: string) => skillInvocations.stateFor(sessionId),
    }),
  })
  pi.registerTool({
    ...createTaskSendTool({
      manager,
      resolveCallerSessionId,
    }),
  })
  pi.registerTool({ ...createTaskCancelTool({ manager }) })
  pi.registerTool({ ...createTaskOutputTool({ manager, stateDir: engine.stateDir, resolveCallerSessionId }) })
}

function createTeamToolContext(
  pi: SenpiExtensionAPI,
  ctx: ComponentContext,
  engine: TaskEngine,
): TeamToolContext {
  const serviceDeps = {
    manager: engine.manager,
    destruction: engine.lifecycle,
    runtime: engine.runtime,
    settings: engine.settings,
    rubatoConfig: engine.rubatoConfig,
    cwd: engine.runtime.cwd(),
    agentNames: new Set(Object.keys(engine.agents)),
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
  return { service, reconcileTeamMailbox: createTeamMailboxReconciler(serviceDeps), deliveryJournal, leadPollers }
}

type TeamToolContext = {
  readonly service: TeamToolsService
  readonly reconcileTeamMailbox: () => Promise<void>
  readonly deliveryJournal: LeadDeliveryJournal
  readonly leadPollers: LeadPollerLifecycle
}

function registerTeamTools(pi: SenpiExtensionAPI, context: TeamToolContext): void {
  for (const tool of buildLeadTeamTools({ service: context.service })) pi.registerTool({ ...tool })
}
