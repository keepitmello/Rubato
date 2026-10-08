import { loadRuntimeState, transitionRuntimeState } from "@rubato/team-core/team-state-store"

import { resolveStateDir } from "../store"
import { readMemberTaskMap, writeMemberTaskMap } from "./member-map"
import { validateSenpiTeamMembers, type SenpiTeamMemberPorts } from "./member-validator"
import { normalizeSenpiTeamSpec } from "./normalize"
import { toTeamCoreConfig } from "./runtime-config"
import type { CreateTeamDeps, CreatedMemberInfo, DeleteTeamDeps } from "./runtime-types"
import { liveMemberNames } from "./shutdown-helpers"
import { spawnTeamMembers } from "./spawn-members"
import { ensureTeamRuntimeDirs, resolveTeamRuntimeDirs, teamStorageBaseDir, withTeamRuntimeMutation } from "./storage"

export type AddTeamMemberInput = {
  readonly teamRunId: string
  readonly name: string
  readonly kind: "owner" | "verifier"
  readonly model: string
  readonly prompt: string
  readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  readonly taskSummary?: string
}

export type AddTeamMemberResult = {
  readonly teamRunId: string
  readonly member: CreatedMemberInfo
}

export class TeamMemberAddError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "TeamMemberAddError"
  }
}

export type AddTeamMemberDeps = CreateTeamDeps & Pick<DeleteTeamDeps, "destruction"> & {
  readonly memberPorts: SenpiTeamMemberPorts
}

/**
 * Add a member to an active team under a new name. Existing peers, mail and board stay as they are;
 * peers reach the new name because member team_send reads the live roster. A name the team already
 * used, including a removed member's, is refused: its inbox and task mapping belong to that member.
 */
export function addTeamMember(input: AddTeamMemberInput, deps: AddTeamMemberDeps): Promise<AddTeamMemberResult> {
  return withTeamRuntimeMutation(deps.stateDir, input.teamRunId, async () => {
    const config = toTeamCoreConfig(deps.taskSettings, teamStorageBaseDir(deps.stateDir))
    const runtime = await loadRuntimeState(input.teamRunId, config)
    const deny = (code: string, message: string): never => { throw new TeamMemberAddError(code, message) }
    if (runtime.leadSessionId !== deps.leadSessionId) deny("not_owner", "Only the owning lead can add a member.")
    if (runtime.status !== "active") deny("team_inactive", "Only an active team can add a member.")
    if (input.prompt.trim().length === 0) deny("missing_brief", "A new member needs a brief with its outcome, intent reference and peers.")
    const spec = normalizeSenpiTeamSpec({
      name: runtime.teamName,
      members: [{
        name: input.name,
        kind: input.kind,
        model: input.model,
        prompt: [
          `You join team '${runtime.teamName}' after it started. Peers already working: ${liveMemberNames(runtime.members).join(", ") || "none"}.`,
          "The board may already hold work and decisions; read it before you start.",
          input.prompt,
        ].join("\n\n"),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.taskSummary !== undefined ? { task_summary: input.taskSummary } : {}),
      }],
    }, runtime.teamName)
    const member = spec.members[0]
    if (member === undefined) return deny("spawn_missing", "The member spec is empty.")
    if (runtime.members.some((peer) => peer.name === member.name)) {
      deny("name_taken", `The team already has or had a member named '${member.name}'. Choose another name; use team_replace_member to swap an existing member's execution.`)
    }
    const maxMembers = deps.taskSettings.team.max_members
    if (liveMemberNames(runtime.members).length + 1 > maxMembers) {
      deny("bounds_exceeded", `The team already has ${maxMembers} live members (max_members). Remove one before adding another.`)
    }
    validateSenpiTeamMembers(spec, deps.memberPorts)
    const { runtimeDir } = await ensureTeamRuntimeDirs(deps.stateDir, input.teamRunId, [member.name])

    const now = deps.now ?? Date.now
    const spawned = await spawnTeamMembers({
      spec,
      teamRunId: input.teamRunId,
      manager: deps.manager,
      leadSessionId: deps.leadSessionId,
      spawnDepth: deps.spawnDepth,
      maxParallel: 1,
      deadlineAt: now() + deps.taskSettings.team.max_wall_clock_minutes * 60_000,
      now,
      ...(deps.memberExtension !== undefined ? {
        memberExtension: {
          ...deps.memberExtension,
          teamConfig: JSON.stringify({
            ...config,
            stateDir: resolveStateDir(deps.stateDir),
            members: [...runtime.members.map((peer) => peer.name), member.name],
          }),
        },
      } : {}),
    })
    if (spawned.failure !== undefined) throw spawned.failure
    const next = spawned.spawned.get(member.name)
    if (next === undefined) return deny("spawn_missing", "The new member did not return a task.")
    let updatedState = false
    try {
      await transitionRuntimeState(input.teamRunId, (current) => {
        if (current.status !== "active") return deny("team_changed", "The team stopped being active while the member started.")
        if (current.members.some((peer) => peer.name === member.name)) return deny("name_taken", `'${member.name}' was added concurrently.`)
        return {
          ...current,
          members: [...current.members, {
            name: member.name,
            kind: member.kind,
            status: next.status,
            pendingInjectedMessageIds: [],
            ...(next.sessionId !== undefined ? { sessionId: next.sessionId } : {}),
            ...(next.resolvedModel !== undefined ? {
              model: { providerID: next.resolvedModel.provider, modelID: next.resolvedModel.model_id },
            } : {}),
          }],
        }
      }, config)
      updatedState = true
      // Final activation point: until the map names the task, the new process cannot send or consume mail.
      const map = await readMemberTaskMap(runtimeDir)
      await (deps.writeMemberMap ?? writeMemberTaskMap)(runtimeDir, { ...map, [member.name]: next.taskId })
    } catch (error) {
      try {
        if (updatedState) {
          await transitionRuntimeState(input.teamRunId, (current) => ({
            ...current,
            members: current.members.filter((peer) => peer.name !== member.name),
          }), config)
        }
      } finally {
        await deps.manager.cancelTask(next.taskId, "team member add rollback")
        await deps.destruction.destroyResidentTask(next.taskId, "cancel")
      }
      throw error
    }
    return {
      teamRunId: input.teamRunId,
      member: {
        name: member.name,
        taskId: next.taskId,
        status: next.status,
        role: { kind: member.kind, model: member.model },
        ...(next.resolvedModel !== undefined ? { model: next.resolvedModel } : {}),
        ...(member.task_summary !== undefined ? { taskSummary: member.task_summary } : {}),
      },
    }
  })
}
