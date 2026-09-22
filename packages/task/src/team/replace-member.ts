import { randomUUID } from "node:crypto"

import { loadRuntimeState, transitionRuntimeState } from "@rubato/team-core/team-state-store"

import { resolveStateDir } from "../store"
import { parseTeamMemberTaskIdentity } from "./liveness-ownership"
import { readMemberTaskMap, writeMemberTaskMap } from "./member-map"
import { validateSenpiTeamMembers, type SenpiTeamMemberPorts } from "./member-validator"
import { normalizeSenpiTeamSpec } from "./normalize"
import { toTeamCoreConfig } from "./runtime-config"
import type { CreateTeamDeps, CreatedMemberInfo, DeleteTeamDeps } from "./runtime-types"
import { spawnTeamMembers } from "./spawn-members"
import { resolveTeamRuntimeDirs, teamStorageBaseDir, withTeamRuntimeMutation } from "./storage"

export type ReplaceTeamMemberInput = {
  readonly teamRunId: string
  readonly member: string
  /** Compare against the current mapping, so a delayed retry cannot replace a newer attempt. */
  readonly expectedTaskId: string
  readonly model: string
  readonly prompt: string
  readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  readonly taskSummary?: string
}

export type ReplaceTeamMemberResult = {
  readonly teamRunId: string
  readonly previousTaskId: string
  readonly member: CreatedMemberInfo
}

export class TeamMemberReplacementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "TeamMemberReplacementError"
  }
}

export type ReplaceTeamMemberDeps = CreateTeamDeps & Pick<DeleteTeamDeps, "destruction"> & {
  readonly memberPorts: SenpiTeamMemberPorts
}

/**
 * Recover an unusable execution without changing its logical team/member, mailbox or board owner.
 * This is explicit recovery, never a model fallback or a replacement for continuing an idle peer.
 * Consumed history is not replayed: the required handoff prompt must name remaining work/artifacts.
 */
export function replaceTeamMember(
  input: ReplaceTeamMemberInput,
  deps: ReplaceTeamMemberDeps,
): Promise<ReplaceTeamMemberResult> {
  return withTeamRuntimeMutation(deps.stateDir, input.teamRunId, async () => {
    const config = toTeamCoreConfig(deps.taskSettings, teamStorageBaseDir(deps.stateDir))
    const runtime = await loadRuntimeState(input.teamRunId, config)
    const deny = (code: string, message: string): never => { throw new TeamMemberReplacementError(code, message) }
    if (runtime.leadSessionId !== deps.leadSessionId) deny("not_owner", "Only the owning lead can replace a member.")
    if (runtime.status !== "active") deny("team_inactive", "Only an active team can replace a member.")
    const member = runtime.members.find((candidate) => candidate.name === input.member)
    if (member === undefined || member.status === "shutdown_approved") {
      return deny("member_unavailable", "The member is missing or has approved shutdown.")
    }
    if (runtime.shutdownRequests.some((request) => request.memberId === input.member && request.approvedAt !== undefined)) {
      deny("shutdown_approved", "Approved shutdown cannot be reopened by member recovery.")
    }
    if (runtime.shutdownRequests.some((request) => request.memberId === input.member && request.rejectedAt === undefined)) {
      deny("shutdown_pending", "Resolve the member's shutdown request before recovery.")
    }
    const { runtimeDir } = resolveTeamRuntimeDirs(deps.stateDir, input.teamRunId)
    const previousMap = await readMemberTaskMap(runtimeDir)
    if (previousMap[input.member] !== input.expectedTaskId) {
      deny("stale_member", "The member's task changed. Do not replace a newer attempt with a stale request.")
    }
    const previous = deps.manager.get(input.expectedTaskId)
    const identity = previous === undefined ? undefined : parseTeamMemberTaskIdentity(previous)
    if (previous === undefined || identity?.teamRunId !== input.teamRunId || identity.memberName !== input.member) {
      return deny("task_unavailable", "The mapped member task cannot be verified.")
    }
    const failed = previous.status === "error" || previous.status === "lost"
    const finishedWithoutSession = previous.status === "completed"
      && (previous.residency_state === "disposed" || previous.residency_state === "evicted")
    if (!failed && !finishedWithoutSession) {
      deny("member_continuable", "Do not replace running, idle/resident, suspended or deliberately cancelled members. Continue or resume them.")
    }
    const spec = normalizeSenpiTeamSpec({
      name: runtime.teamName,
      members: [{
        name: member.name,
        kind: member.kind,
        model: input.model,
        prompt: [
          `You replace failed/unavailable task ${previous.task_id} as '${member.name}' in this same team.`,
          "Your peer address and board ownership are unchanged. Read the handoff artifacts and outstanding requests.",
          "Earlier verdicts cover only their checked revisions, not subsequent edits. Recheck changed claims from original evidence.",
          "Send technical defects and recheck requests directly to the responsible owner, even when a lead suggested the disproved method. Escalate intent, criterion, authority or resource changes to the lead.",
          input.prompt,
        ].join("\n\n"),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.taskSummary !== undefined ? { task_summary: input.taskSummary } : {}),
        ...(member.worktreePath !== undefined ? { worktreePath: member.worktreePath } : {}),
      }],
    }, runtime.teamName)
    // Validate the exact route and handoff before destroying the failed execution.
    if (input.prompt.trim().length === 0) deny("missing_handoff", "A replacement needs a handoff with artifacts, checked revisions and remaining work.")
    validateSenpiTeamMembers(spec, deps.memberPorts)
    await deps.destruction.destroyResidentTask(previous.task_id, "reconcile_lost")

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
      attemptId: randomUUID(),
      ...(deps.memberExtension !== undefined ? {
        memberExtension: {
          ...deps.memberExtension,
          teamConfig: JSON.stringify({
            ...config,
            stateDir: resolveStateDir(deps.stateDir),
            members: runtime.members.map((peer) => peer.name),
          }),
        },
      } : {}),
    })
    if (spawned.failure !== undefined) throw spawned.failure
    const next = spawned.spawned.get(member.name)
    if (next === undefined) return deny("spawn_missing", "Replacement did not return a task.")
    let updatedState = false
    try {
      await transitionRuntimeState(input.teamRunId, (current) => {
        if (current.status !== "active"
          || current.members.some((peer) => peer.name === member.name && peer.status === "shutdown_approved")
          || current.shutdownRequests.some((request) => request.memberId === member.name && request.rejectedAt === undefined)) {
          return deny("team_changed", "The team began shutdown during replacement.")
        }
        return {
          ...current,
          members: current.members.map((peer) => {
            if (peer.name !== member.name) return peer
            const { sessionId: _session, model: _model, lastInjectedTurnMarker: _marker, ...rest } = peer
            return {
              ...rest,
              status: next.status,
              pendingInjectedMessageIds: [],
              ...(next.sessionId !== undefined ? { sessionId: next.sessionId } : {}),
              ...(next.resolvedModel !== undefined ? {
                model: { providerID: next.resolvedModel.provider, modelID: next.resolvedModel.model_id },
              } : {}),
            }
          }),
        }
      }, config)
      updatedState = true
      // Final activation point: until the map changes the new process cannot consume peer mail.
      await (deps.writeMemberMap ?? writeMemberTaskMap)(runtimeDir, { ...previousMap, [member.name]: next.taskId })
    } catch (error) {
      // The map was not published: retain the failed address and unread mail for an explicit retry.
      try {
        if (updatedState) {
          await transitionRuntimeState(input.teamRunId, (current) => ({
            ...current,
            members: current.members.map((peer) => peer.name === member.name ? member : peer),
          }), config)
        }
      } finally {
        await deps.manager.cancelTask(next.taskId, "team member replacement rollback")
        await deps.destruction.destroyResidentTask(next.taskId, "cancel")
      }
      throw error
    }
    return {
      teamRunId: input.teamRunId,
      previousTaskId: previous.task_id,
      member: {
        name: member.name,
        taskId: next.taskId,
        status: next.status,
        role: { kind: member.kind, model: input.model },
        ...(next.resolvedModel !== undefined ? { model: next.resolvedModel } : {}),
        ...(input.taskSummary !== undefined ? { taskSummary: input.taskSummary } : {}),
      },
    }
  })
}
