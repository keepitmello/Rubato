import { fileURLToPath } from "node:url"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { TeamModeConfigSchema, type TeamModeConfig } from "@rubato/team-core/config"
import { loadRuntimeState } from "@rubato/team-core/team-state-store"
import { log } from "@rubato/utils"

import { parseTaskId, type TaskId } from "../../state"
import { createTaskRecordStore } from "../../store"
import { buildMemberTeamBoardTools, type TeamToolsService } from "../../tools/team"
import {
  claimTeamTask,
  createTeamTask,
  getTeamTask,
  listTeamTasks,
  updateTeamTaskStatus,
  type TeamTasklistContext,
} from "../tasks"
import {
  MEMBER_EXTENSION_BUNDLE_NAME,
  MEMBER_IDENTITY_ENV,
  MEMBER_TASK_ID_ENV,
  MEMBER_TEAM_CONFIG_ENV,
  LEGACY_MEMBER_IDENTITY_ENV,
  LEGACY_MEMBER_TASK_ID_ENV,
  LEGACY_MEMBER_TEAM_CONFIG_ENV,
  memberIdentityValue,
} from "./identity"
import { createMemberSelfPoller, type MemberSelfPoller } from "./self-poller"
import { createQaAfterInjectHold } from "./qa-inject-hold"
import {
  TEAM_REPORT_REMINDER_CONTENT,
  TEAM_REPORT_REMINDER_TYPE,
  createReportReminder,
} from "./report-reminder"
import { createMemberTaskSendTool } from "./tools"
import { readMemberTaskMap } from "../member-map"
import { resolveTeamRuntimeDirs } from "../storage"

export {
  MEMBER_EXTENSION_BUNDLE_NAME,
  MEMBER_IDENTITY_ENV,
  MEMBER_PROCESS_ENV_NAMES,
  MEMBER_TASK_ID_ENV,
  MEMBER_TEAM_CONFIG_ENV,
  isTeamMemberProcess,
} from "./identity"

const MEMBER_POLL_INTERVAL_MS = 1_000
const ACK_POLL_INTERVAL_MS = 100
const MEMBER_NAME_PATTERN = /^[a-z0-9-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ParsedMemberExtensionEnv = {
  readonly teamRunId: string
  readonly memberName: string
  readonly taskId: TaskId
  readonly stateDir: string
  readonly sessionDir: string
  readonly config: TeamModeConfig & { readonly base_dir: string }
  readonly members: readonly string[]
}

export type MemberExtensionConfigErrorCode =
  | "missing_env"
  | "invalid_identity"
  | "invalid_task_id"
  | "invalid_team_config"

export class MemberExtensionConfigError extends Error {
  readonly code: MemberExtensionConfigErrorCode

  constructor(message: string, code: MemberExtensionConfigErrorCode) {
    super(message)
    this.name = "MemberExtensionConfigError"
    this.code = code
  }
}

type ActiveRuntime = {
  poller: MemberSelfPoller
  started: boolean
  pollTimer?: ReturnType<typeof setInterval>
  ackTimer?: ReturnType<typeof setInterval>
}

const activeRuntimes = new WeakMap<ExtensionAPI, ActiveRuntime>()

export function resolveMemberExtensionEntryPath(extensionUrl = import.meta.url): string {
  return fileURLToPath(new URL(`./${MEMBER_EXTENSION_BUNDLE_NAME}`, extensionUrl))
}

export function parseMemberExtensionEnv(env: NodeJS.ProcessEnv): ParsedMemberExtensionEnv {
  const identity = memberIdentityValue(env) ?? requiredEnv(env, MEMBER_IDENTITY_ENV)
  const taskIdRaw = firstPresentEnv(env, [MEMBER_TASK_ID_ENV, LEGACY_MEMBER_TASK_ID_ENV])
  const teamConfigRaw = firstPresentEnv(env, [MEMBER_TEAM_CONFIG_ENV, LEGACY_MEMBER_TEAM_CONFIG_ENV])
  const sessionDir = firstPresentEnv(env, ["PI_CODING_AGENT_SESSION_DIR", "SENPI_CODING_AGENT_SESSION_DIR"])
  const identityParts = identity.split("::")
  const teamRunId = identityParts[0]
  const memberName = identityParts[1]
  if (
    identityParts.length !== 2
    || teamRunId === undefined
    || memberName === undefined
    || !UUID_PATTERN.test(teamRunId)
    || !MEMBER_NAME_PATTERN.test(memberName)
  ) {
    throw new MemberExtensionConfigError(
      `${MEMBER_IDENTITY_ENV} must be '<teamRunId>::<memberName>'`,
      "invalid_identity",
    )
  }

  let taskId: TaskId
  try {
    taskId = parseTaskId(taskIdRaw)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    throw new MemberExtensionConfigError("RUBATO_TASK_MEMBER_TASK_ID must be a valid st_ task id", "invalid_task_id")
  }

  const rawConfig = parseJsonRecord(teamConfigRaw)
  const stateDir = rawConfig.stateDir
  const members = parseMembers(rawConfig.members)
  const configResult = TeamModeConfigSchema.safeParse(rawConfig)
  if (
    typeof stateDir !== "string"
    || stateDir.length === 0
    || !configResult.success
    || configResult.data.base_dir === undefined
    || !members.includes(memberName)
  ) {
    throw new MemberExtensionConfigError("RUBATO_TASK_TEAM_CONFIG is malformed", "invalid_team_config")
  }

  return {
    teamRunId,
    memberName,
    taskId,
    stateDir,
    sessionDir,
    config: { ...configResult.data, base_dir: configResult.data.base_dir },
    members,
  }
}

export default async function registerMemberExtension(pi: ExtensionAPI): Promise<void> {
  if (activeRuntimes.has(pi)) return
  const parsed = parseMemberExtensionEnv(process.env)
  const store = createTaskRecordStore({ project_dir: parsed.stateDir, task: { state_dir: parsed.stateDir } })
  const afterInject = createQaAfterInjectHold(process.env)
  const appendEvent = (event: Parameters<typeof store.appendEvent>[1]): void => {
    store.appendEvent(parsed.taskId, event)
  }
  const runtime: ActiveRuntime = { poller: undefined as never, started: false }
  const reminder = createReportReminder(() => {
    if (!runtime.started) return
    pi.sendMessage(
      {
        customType: TEAM_REPORT_REMINDER_TYPE,
        content: TEAM_REPORT_REMINDER_CONTENT,
        display: false,
      },
      { triggerTurn: true, deliverAs: "steer" },
    )
  })
  const isCurrentMember = async (): Promise<boolean> => {
    const { runtimeDir } = resolveTeamRuntimeDirs(
      { project_dir: parsed.stateDir, task: { state_dir: parsed.stateDir } },
      parsed.teamRunId,
    )
    return (await readMemberTaskMap(runtimeDir))[parsed.memberName] === parsed.taskId
  }
  runtime.poller = createMemberSelfPoller({
    teamRunId: parsed.teamRunId,
    memberName: parsed.memberName,
    config: parsed.config,
    sessionDir: parsed.sessionDir,
    isCurrentMember,
    inject: (content, messageId) => {
      reminder.onInboundWork()
      pi.sendMessage(
        {
          customType: "senpi-task:team-message",
          content,
          display: false,
          details: { messageId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      )
    },
    appendEvent,
    ...(afterInject !== undefined ? { afterInject } : {}),
  })
  activeRuntimes.set(pi, runtime)

  pi.registerTool(createMemberTaskSendTool({
    teamRunId: parsed.teamRunId,
    memberName: parsed.memberName,
    taskId: parsed.taskId,
    config: parsed.config,
    members: parsed.members,
    isCurrentMember,
    appendEvent: (taskId, event) => store.appendEvent(taskId, event),
    onSent: () => reminder.onTeamSend(),
  }))
  for (const tool of buildMemberTeamBoardTools({ service: createMemberBoardService(parsed) })) {
    pi.registerTool(tool)
  }
  pi.on("session_start", () => startRuntime(runtime))
  pi.on("session_shutdown", () => stopRuntime(pi, runtime))
  pi.on("agent_start", () => reminder.onTurnStart())
  pi.on("agent_settled", () => reminder.onTurnSettled())
}

async function startRuntime(runtime: ActiveRuntime): Promise<void> {
  if (runtime.started) return
  runtime.started = true
  // Timers first: session_start fires once per process, so a first poll that fails (an inbox
  // lock left by a crash) must not leave the member deaf to team mail for the rest of its life.
  // pollOnce recovers reservations itself until that succeeds.
  runtime.pollTimer = setInterval(() => runSafely("poll", runtime.poller.pollOnce()), MEMBER_POLL_INTERVAL_MS)
  runtime.ackTimer = setInterval(() => runSafely("ack", runtime.poller.checkPendingAcks()), ACK_POLL_INTERVAL_MS)
  try {
    await runtime.poller.recoverReservations()
    if (!runtime.started) return
    await runtime.poller.pollOnce()
  } catch (error) {
    log("senpi-task member extension first poll failed; the poll timer keeps retrying", { error: String(error) })
  }
}

function stopRuntime(pi: ExtensionAPI, runtime: ActiveRuntime): void {
  runtime.started = false
  if (runtime.pollTimer !== undefined) clearInterval(runtime.pollTimer)
  if (runtime.ackTimer !== undefined) clearInterval(runtime.ackTimer)
  delete runtime.pollTimer
  delete runtime.ackTimer
  runtime.poller.shutdown()
  activeRuntimes.delete(pi)
}

function runSafely(operation: string, promise: Promise<void>): void {
  promise.catch((error: unknown) => {
    log("senpi-task member extension poll failed", { operation, error: String(error) })
  })
}

export function createMemberBoardService(parsed: ParsedMemberExtensionEnv): TeamToolsService {
  const ctx: TeamTasklistContext = { teamRunId: parsed.teamRunId, config: parsed.config }
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not available on the member board`)
  }
  // Members reach the board by the run id team_create returned, but a member never sees that id:
  // it knows the team by the name it was spawned under and often passes that instead. Resolve the
  // name from this run's own state file — a member may only ever see its own team, so this read is
  // the only source. A missing or unreadable state file costs the name alias, never the run id, and
  // is retried on the next call so a state file written after startup is still picked up.
  let ownTeamNameCache: string | undefined
  let ownTeamNameInFlight: Promise<string | undefined> | undefined
  const ownTeamName = (): Promise<string | undefined> => {
    if (ownTeamNameCache !== undefined) return Promise.resolve(ownTeamNameCache)
    ownTeamNameInFlight ??= loadRuntimeState(parsed.teamRunId, parsed.config)
      .then((runtimeState) => {
        ownTeamNameCache = runtimeState.teamName
        return runtimeState.teamName
      })
      .catch(() => undefined)
      .finally(() => {
        ownTeamNameInFlight = undefined
      })
    return ownTeamNameInFlight
  }
  const assertOwnTeam = async (teamRunId: string): Promise<void> => {
    if (teamRunId === parsed.teamRunId) return
    const ownName = await ownTeamName()
    if (ownName !== undefined && teamRunId === ownName) return
    // Name both handles so a member that passed the other one can retry with the value it has.
    const belongsTo = ownName === undefined
      ? `run id ${parsed.teamRunId}`
      : `team ${ownName} (run id ${parsed.teamRunId})`
    throw new Error(`Team ${teamRunId} is not this member's team. This member belongs to ${belongsTo}.`)
  }
  return {
    createTeam: unused("createTeam"),
    replaceMember: unused("replaceMember"),
    deleteTeam: unused("deleteTeam"),
    sendMessage: unused("sendMessage"),
    status: unused("status"),
    listTeams: unused("listTeams"),
    requestShutdown: unused("requestShutdown"),
    approveShutdown: unused("approveShutdown"),
    rejectShutdown: unused("rejectShutdown"),
    createTask: async (teamRunId, input) => {
      await assertOwnTeam(teamRunId)
      return createTeamTask(ctx, input)
    },
    listTasks: async (teamRunId, filter) => {
      await assertOwnTeam(teamRunId)
      return listTeamTasks(ctx, filter)
    },
    getTask: async (teamRunId, taskId) => {
      await assertOwnTeam(teamRunId)
      return getTeamTask(ctx, taskId)
    },
    updateTask: async (input) => {
      await assertOwnTeam(input.teamRunId)
      const owner = input.owner ?? parsed.memberName
      return input.status === "claimed"
        ? claimTeamTask(ctx, input.taskId, owner)
        : updateTeamTaskStatus(ctx, input.taskId, input.status, owner)
    },
  }
}

function firstPresentEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value.length > 0) return value
  }
  throw new MemberExtensionConfigError(`Missing ${names[0]}`, "missing_env")
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  return firstPresentEnv(env, [name])
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    if (isRecord(value)) return value
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // Normalized below as the typed config error.
  }
  throw new MemberExtensionConfigError("RUBATO_TASK_TEAM_CONFIG must be a JSON object", "invalid_team_config")
}

function parseMembers(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((member) => typeof member === "string" && MEMBER_NAME_PATTERN.test(member))) {
    throw new MemberExtensionConfigError("RUBATO_TASK_TEAM_CONFIG.members is malformed", "invalid_team_config")
  }
  return [...new Set(value)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
