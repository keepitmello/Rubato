import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type, type Static } from "typebox"

import { isPlainRecord } from "@rubato/utils"

import { clampTaskSummary, TASK_SUMMARY_MAX_LENGTH } from "../../task-summary"
import { SenpiTeamRuntimeError, SenpiTeamSpecError, TeamMemberReplacementError } from "../../team"
import { toolResult } from "../control"
import { stableModelEnum, TaskToolEffort } from "../task/params"
import type { TeamToolDeps, TeamToolsService } from "./types"

export const TeamReplaceMemberParams = Type.Object({
  team_run_id: Type.String({ description: "Existing team run. Its peer addresses and board owners stay unchanged." }),
  member: Type.String({ description: "Existing member name. Its owner/verifier role is preserved." }),
  expected_task_id: Type.String({ description: "Current member task id (st_...). A stale id fails closed." }),
  model: Type.String({ description: "Exact approved provider/model from the live Agent catalog; no fallback." }),
  prompt: Type.String({ minLength: 1, description: "English handoff: accepted intent, artifact paths, checked revisions, outstanding requests and remaining work. Prior verdicts do not automatically cover edits." }),
  effort: Type.Optional(TaskToolEffort),
  task_summary: Type.Optional(Type.String({ maxLength: TASK_SUMMARY_MAX_LENGTH, description: "One-line recovery assignment." })),
  user_approval_ref: Type.Optional(Type.String({ minLength: 1, description: "Only for a model/effort change the user explicitly approved: quote or reference the user's approving message. With it a running, idle, suspended or cancelled member is stopped and replaced. Omit for failure recovery; never use it for your own model choice or a fallback." })),
}, { additionalProperties: false })

export type TeamReplaceMemberInput = Static<typeof TeamReplaceMemberParams>

export async function runTeamReplaceMember(service: TeamToolsService, input: TeamReplaceMemberInput) {
  try {
    const result = await service.replaceMember({
      teamRunId: input.team_run_id,
      member: input.member,
      expectedTaskId: input.expected_task_id,
      model: input.model,
      prompt: input.prompt,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.task_summary !== undefined ? { taskSummary: input.task_summary } : {}),
      ...(input.user_approval_ref !== undefined ? { userApprovalRef: input.user_approval_ref } : {}),
    })
    const why = result.reason === "user_approved_change" ? "User-approved model change" : "Recovery"
    return toolResult(
      `${why}: replaced '${result.member.name}' in team ${result.teamRunId}: ${result.previousTaskId} -> ${result.member.taskId}. Same peer address, role, inbox and board ownership; unread mail is retained. Previously consumed requests must be carried in the handoff. Spawn is not a completed verification.`,
      {
        kind: "replaced", reason: result.reason, team_run_id: result.teamRunId, previous_task_id: result.previousTaskId,
        member: {
          name: result.member.name, task_id: result.member.taskId, status: result.member.status,
          role: result.member.role.kind, requested_model: result.member.role.model,
          ...(result.member.model !== undefined ? { model: result.member.model } : {}),
          ...(result.member.taskSummary !== undefined ? { task_summary: result.member.taskSummary } : {}),
        },
      },
    )
  } catch (error) {
    if (error instanceof TeamMemberReplacementError || error instanceof SenpiTeamRuntimeError || error instanceof SenpiTeamSpecError) {
      return toolResult(error.message, { kind: "replacement_rejected", code: error.code, reason: error.message })
    }
    throw error
  }
}

export function createTeamReplaceMemberTool(deps: TeamToolDeps): ToolDefinition {
  const parameters = Type.Object({
    ...TeamReplaceMemberParams.properties,
    model: Type.String({ ...TeamReplaceMemberParams.properties.model }),
  }, { additionalProperties: false })
  Object.defineProperty(parameters.properties.model, "enum", {
    configurable: true,
    enumerable: true,
    get: stableModelEnum(() => deps.models?.list?.() ?? []),
  })
  return {
    name: "team_replace_member",
    label: "Team Replace Member",
    description: "Lead-only replacement of a member in the SAME team, preserving its name, peer address, mail and board ownership. Use it for two cases only: recovering a failed/unavailable member, or a model/effort change the user explicitly approved (pass user_approval_ref; a running, idle, suspended or cancelled member is then stopped first). Never create a separate team for this. Without user approval, continue an idle/resident peer instead; do not swap a working peer or fall back to another model on your own. Carry the handoff artifacts, checked revisions and pending work. Old verdicts apply only to their checked revision. Returns replacement_rejected without silently changing models.",
    parameters,
    prepareArguments: prepareTeamReplaceMemberArguments,
    execute: (_id, input: TeamReplaceMemberInput) => runTeamReplaceMember(deps.service, input),
  }
}

// Runs before schema validation: an over-long task_summary is truncated, not a rejected recovery.
export function prepareTeamReplaceMemberArguments(raw: unknown): TeamReplaceMemberInput {
  if (!isPlainRecord(raw) || typeof raw.task_summary !== "string") return raw as TeamReplaceMemberInput
  const { task_summary: summary, ...rest } = raw
  const clamped = clampTaskSummary(summary)
  return (clamped === undefined ? rest : { ...rest, task_summary: clamped }) as TeamReplaceMemberInput
}
