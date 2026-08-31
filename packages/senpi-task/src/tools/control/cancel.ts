import type { ToolDefinition } from "@code-yeongyu/senpi"
import { Type } from "typebox"
import type { Static } from "typebox"

import type { TaskStatus } from "../../state"
import { createSenpiAgentHandle } from "../host/senpi-agent-host"
import { renderTaskCancelCall, renderTaskCancelResult } from "./renderers"
import { toolResult } from "./tool-result"
import type { CancelManager, CancelResultDetails, CancelToolResult } from "./types"

export const TaskCancelParams = Type.Object({
  agentId: Type.String({ description: "agentId of the child to cancel." }),
})

export type TaskCancelInput = Static<typeof TaskCancelParams> & { readonly reason?: string }

const DESCRIPTION = [
  "Cancel a running child agent and release its resources; the cancelled status is preserved so AgentOutput can still report the outcome.",
  "Cancel is terminal and NOT resumable; cancelling a child that is not running is a no-op that reports its unchanged status.",
  "Use this to end work you no longer need.",
].join(" ")

export type TaskCancelDeps = {
  readonly manager: CancelManager
}

export async function runTaskCancel(manager: CancelManager, params: Partial<TaskCancelInput>): Promise<CancelToolResult> {
  const agentId = params.agentId?.trim()
  if (agentId === undefined || agentId.length === 0) {
    return toolResult("agentId is required", {
      kind: "invalid_arguments",
      reason: "agentId is required",
    })
  }

  const handle = createSenpiAgentHandle(manager, agentId)
  const outcome = await handle.cancelChild(params.reason)
  switch (outcome.kind) {
    case "cancelled": {
      const status = manager.get(outcome.task_id)?.status ?? ("cancelled" satisfies TaskStatus)
      return toolResult(`Cancelled ${outcome.task_id} (was ${outcome.previous_status}, now ${status}).`, {
        kind: "cancelled",
        agentId: outcome.task_id,
        previous_status: outcome.previous_status,
        status,
      })
    }
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

export function createTaskCancelTool(deps: TaskCancelDeps): ToolDefinition<typeof TaskCancelParams, CancelResultDetails> {
  return {
    name: "AgentCancel",
    label: "Agent Cancel",
    description: DESCRIPTION,
    parameters: TaskCancelParams,
    execute: (_toolCallId, params) => runTaskCancel(deps.manager, params),
    renderCall: (args, theme) => renderTaskCancelCall(args, theme),
    renderResult: (result, options, theme) => renderTaskCancelResult(result, options, theme),
  }
}
