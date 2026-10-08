import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type, type Static } from "typebox"

import { isPlainRecord } from "@rubato/utils"

import { clampTaskSummary, TASK_SUMMARY_MAX_LENGTH } from "../../task-summary"
import { SenpiTeamRuntimeError, SenpiTeamSpecError, TeamMemberAddError } from "../../team"
import { toolResult } from "../control"
import { stableModelEnum, TaskToolEffort } from "../task/params"
import type { TeamToolDeps, TeamToolsService } from "./types"

export const TeamAddMemberParams = Type.Object({
  team_run_id: Type.String({ description: "Existing active team run." }),
  name: Type.String({ description: "New member name, unique within the team (a removed member's name stays taken)." }),
  kind: Type.Union([Type.Literal("owner"), Type.Literal("verifier")], {
    description: "Taskforce role. Owners hold one bounded outcome; verifiers independently judge results and acceptance criteria.",
  }),
  model: Type.String({ description: "Exact approved provider/model from the live Agent catalog; no fallback." }),
  prompt: Type.String({ minLength: 1, description: "English brief: accepted intent_ref, outcome, write ownership, peers to coordinate with and done evidence." }),
  effort: Type.Optional(TaskToolEffort),
  task_summary: Type.Optional(Type.String({ maxLength: TASK_SUMMARY_MAX_LENGTH, description: "One-line summary of the new member's assignment." })),
}, { additionalProperties: false })

export type TeamAddMemberInput = Static<typeof TeamAddMemberParams>

export async function runTeamAddMember(service: TeamToolsService, input: TeamAddMemberInput) {
  try {
    const result = await service.addMember({
      teamRunId: input.team_run_id,
      name: input.name,
      kind: input.kind,
      model: input.model,
      prompt: input.prompt,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.task_summary !== undefined ? { taskSummary: input.task_summary } : {}),
    })
    return toolResult(
      `Added '${result.member.name}' (${result.member.role.kind}) to team ${result.teamRunId} as ${result.member.taskId}. Existing peers can team_send it now; tell the peers it must coordinate with, and record its assignment on the board.`,
      {
        kind: "added", team_run_id: result.teamRunId,
        member: {
          name: result.member.name, task_id: result.member.taskId, status: result.member.status,
          role: result.member.role.kind, requested_model: result.member.role.model,
          ...(result.member.model !== undefined ? { model: result.member.model } : {}),
          ...(result.member.taskSummary !== undefined ? { task_summary: result.member.taskSummary } : {}),
        },
      },
    )
  } catch (error) {
    if (error instanceof TeamMemberAddError || error instanceof SenpiTeamRuntimeError || error instanceof SenpiTeamSpecError) {
      return toolResult(error.message, { kind: "add_rejected", code: error.code, reason: error.message })
    }
    throw error
  }
}

export function createTeamAddMemberTool(deps: TeamToolDeps): ToolDefinition {
  const parameters = Type.Object({
    ...TeamAddMemberParams.properties,
    model: Type.String({ ...TeamAddMemberParams.properties.model }),
  }, { additionalProperties: false })
  Object.defineProperty(parameters.properties.model, "enum", {
    configurable: true,
    enumerable: true,
    get: stableModelEnum(() => deps.models?.list?.() ?? []),
  })
  return {
    name: "team_add_member",
    label: "Team Add Member",
    description: "Lead-only: add an owner or verifier to an existing active team under a new name, keeping the team's peers, mail and board. Use it instead of creating a second team when the approved roster grows. Existing peers can message the new member immediately. To remove a member, use team_shutdown_request then team_approve_shutdown; to swap a member's model or recover a failed one, use team_replace_member. Returns add_rejected without starting anything when the name is taken, the team is full or the model is unavailable.",
    parameters,
    prepareArguments: prepareTeamAddMemberArguments,
    execute: (_id, input: TeamAddMemberInput) => runTeamAddMember(deps.service, input),
  }
}

// Runs before schema validation: an over-long task_summary is truncated, not a rejected add.
export function prepareTeamAddMemberArguments(raw: unknown): TeamAddMemberInput {
  if (!isPlainRecord(raw) || typeof raw.task_summary !== "string") return raw as TeamAddMemberInput
  const { task_summary: summary, ...rest } = raw
  const clamped = clampTaskSummary(summary)
  return (clamped === undefined ? rest : { ...rest, task_summary: clamped }) as TeamAddMemberInput
}
