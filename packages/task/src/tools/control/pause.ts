import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { Static } from "typebox"

import { parseTeamMemberTaskIdentity } from "../../team"
import { toolResult } from "./tool-result"
import type { PauseManager, PauseResultDetails, PauseToolResult } from "./types"

export const TaskPauseParams = Type.Object({
  agentId: Type.Optional(Type.String({ description: "agentId of one running child or team member to pause." })),
  team_run_id: Type.Optional(Type.String({ description: "Pause every running member of this team." })),
})

export type TaskPauseInput = Static<typeof TaskPauseParams>

const DESCRIPTION = [
  "Pause a running child agent or team member: its current turn stops now and its session stays, with the text it had written kept as its result.",
  "Give agentId for one, or team_run_id for every running member of that team.",
  "A paused agent resumes in the same session when you send it a message with AgentSend; use AgentCancel only to end work for good.",
].join(" ")

export type TaskPauseDeps = {
  readonly manager: PauseManager
}

export async function runTaskPause(manager: PauseManager, params: Partial<TaskPauseInput>): Promise<PauseToolResult> {
  const agentId = params.agentId?.trim() ?? ""
  const teamRunId = params.team_run_id?.trim() ?? ""
  if ((agentId.length > 0) === (teamRunId.length > 0)) {
    const reason = "give exactly one of agentId or team_run_id"
    return toolResult(reason, { kind: "invalid_arguments", reason })
  }

  if (agentId.length > 0) {
    const outcome = await manager.interruptTask(agentId)
    switch (outcome.kind) {
      case "interrupted":
        return toolResult(`Paused ${outcome.task_id}. Send it a message with AgentSend to resume.`, {
          kind: "paused",
          agentIds: [outcome.task_id],
        })
      case "noop":
        return toolResult(`${outcome.reason} No change.`, {
          kind: "noop",
          agentId: outcome.task_id,
          status: outcome.status,
          reason: outcome.reason,
        })
      case "not_found":
        return toolResult(outcome.reason, { kind: "not_found", reason: outcome.reason })
    }
  }

  const running = manager
    .list({ scope: "all" })
    .map((entry) => entry.record)
    .filter((record) => record.status === "running" && parseTeamMemberTaskIdentity(record)?.teamRunId === teamRunId)
  const paused: string[] = []
  for (const record of running) {
    const outcome = await manager.interruptTask(record.task_id)
    if (outcome.kind === "interrupted") paused.push(outcome.task_id)
  }
  if (paused.length === 0) {
    const reason = `No running member in team ${teamRunId}.`
    return toolResult(`${reason} No change.`, { kind: "team_noop", team_run_id: teamRunId, reason })
  }
  return toolResult(`Paused ${paused.length} member(s) of team ${teamRunId}: ${paused.join(", ")}. Message a member to resume it.`, {
    kind: "paused",
    agentIds: paused,
    team_run_id: teamRunId,
  })
}

export function createTaskPauseTool(deps: TaskPauseDeps): ToolDefinition<typeof TaskPauseParams, PauseResultDetails> {
  return {
    name: "AgentPause",
    label: "Agent Pause",
    description: DESCRIPTION,
    parameters: TaskPauseParams,
    execute: (_toolCallId, params) => runTaskPause(deps.manager, params),
  }
}
