import type { ToolDefinition } from "@code-yeongyu/senpi"
import { Type, type Static } from "typebox"

import { TASK_SUMMARY_MAX_LENGTH } from "../../task-summary"
import { SenpiTeamRuntimeError, SenpiTeamSpecError, TeamMemberReplacementError } from "../../team"
import { toolResult } from "../control"
import { TaskToolEffort } from "../task/params"
import type { TeamToolDeps, TeamToolsService } from "./types"

export const TeamReplaceMemberParams = Type.Object({
  team_run_id: Type.String({ description: "Existing team run. Its peer addresses and board owners stay unchanged." }),
  member: Type.String({ description: "Existing member name. Its owner/verifier role is preserved." }),
  expected_task_id: Type.String({ description: "Current failed/unavailable member task id (st_...). A stale id fails closed." }),
  model: Type.String({ description: "Exact approved provider/model from the live Agent catalog; no fallback." }),
  prompt: Type.String({ minLength: 1, description: "English handoff: accepted intent, artifact paths, checked revisions, outstanding requests and remaining work. Prior verdicts do not automatically cover edits." }),
  effort: Type.Optional(TaskToolEffort),
  task_summary: Type.Optional(Type.String({ maxLength: TASK_SUMMARY_MAX_LENGTH, description: "One-line recovery assignment." })),
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
    })
    return toolResult(
      `Replaced '${result.member.name}' in team ${result.teamRunId}: ${result.previousTaskId} -> ${result.member.taskId}. Same peer address, role, inbox and board ownership; unread mail is retained. Previously consumed requests must be carried in the handoff. Spawn is not a completed verification.`,
      {
        kind: "replaced", team_run_id: result.teamRunId, previous_task_id: result.previousTaskId,
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
    get: () => {
      const models = deps.models?.list?.() ?? []
      return models.length === 0 ? undefined : [...models].sort()
    },
  })
  return {
    name: "team_replace_member",
    label: "Team Replace Member",
    description: "Lead-only recovery of a failed/unavailable member in the SAME team, preserving peer mail and board ownership. Do not create a separate replacement team or replace an idle/resident peer: continue it. Use only an approved model and carry the handoff artifacts, checked revisions and pending work. Model/cost/scope changes still require user approval. Old verdicts apply only to their checked revision. Returns replacement_rejected without silently changing models.",
    parameters,
    execute: (_id, input: TeamReplaceMemberInput) => runTeamReplaceMember(deps.service, input),
  }
}
