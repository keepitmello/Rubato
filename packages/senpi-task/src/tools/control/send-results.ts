import type { SendManager, SendToolResult } from "./types"
import { toolResult } from "./tool-result"

export function invalidArguments(reason: string): SendToolResult {
  return toolResult(reason, { kind: "invalid_arguments", reason })
}
export function notFound(manager: SendManager, reason: string, callerSessionId: string | undefined): SendToolResult {
  const known = knownAgentNames(manager, callerSessionId)
  const listText = known.length > 0 ? ` Known agents in this session: ${known.join(", ")}.` : ""
  return toolResult(`${reason}${listText}`, { kind: "not_found", reason, known_agents: known })
}

function knownAgentNames(manager: SendManager, callerSessionId: string | undefined): readonly string[] {
  const scope = callerSessionId === undefined ? ({ scope: "all" } as const) : ({ scope: "parent-session", session_id: callerSessionId } as const)
  const names: string[] = []
  for (const listed of manager.list(scope)) {
    names.push(listed.record.name ?? listed.record.task_id)
  }
  return names
}

export function mapSendOutcome(outcome: Awaited<ReturnType<SendManager["sendToTask"]>>): SendToolResult {
  switch (outcome.kind) {
    case "steered": {
      if (outcome.delivered !== "steer") {
        throw new Error(`AgentSend invariant violated: expected steer delivery, received ${outcome.delivered}`)
      }
      return toolResult(`Delivered to ${outcome.task_id} as ${outcome.delivered}.`, {
        kind: "steered",
        agentId: outcome.task_id,
        status: outcome.status,
        delivered: outcome.delivered,
      })
    }
    case "revived":
      return toolResult(`Revived ${outcome.task_id} (run epoch ${outcome.run_epoch}).`, {
        kind: "revived",
        agentId: outcome.task_id,
        run_epoch: outcome.run_epoch,
      })
    case "capacity_deferred":
      return toolResult(outcome.reason, { kind: "capacity_deferred", agentId: outcome.task_id, reason: outcome.reason })
    case "queued":
      return toolResult(`Queued for ${outcome.task_id} at position ${outcome.queue_position}.`, {
        kind: "queued",
        agentId: outcome.task_id,
        queue_position: outcome.queue_position,
      })
    case "not_continuable":
      return toolResult(`${outcome.reason} ${outcome.suggestion}`, {
        kind: "not_continuable",
        agentId: outcome.task_id,
        reason: outcome.reason,
        suggestion: outcome.suggestion,
      })
    case "one_shot_agent":
      return toolResult(outcome.message, {
        kind: "one_shot_agent",
        agentId: outcome.task_id,
        agent: outcome.agent,
        message: outcome.message,
      })
    case "scope_denied":
      return toolResult(outcome.reason, {
        kind: "scope_denied",
        agentId: outcome.task_id,
        owning_session_id: outcome.owning_session_id,
        reason: outcome.reason,
      })
    case "not_found":
      return toolResult(outcome.reason, { kind: "not_found", reason: outcome.reason, known_agents: [] })
  }
}
