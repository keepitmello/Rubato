import type { ExecutionMode, StartResult } from "../../manager"
import type { TaskRecord } from "../../state"
import type { TaskToolDetails, TaskToolMode } from "./types"

export type SingleSpawnParams = {
  readonly prompt: string
  readonly summary?: string
  readonly preset?: string
  readonly model?: string
}

export function recordSummary(record: TaskRecord, includeLifecycle?: boolean) {
  return {
    task_id: record.task_id,
    status: record.status,
    task_summary: record.task_summary,
    name: record.name,
    category: record.category,
    execution_mode: record.execution_mode,
    model: record.model,
    run_stats: record.run_stats,
    ...(includeLifecycle && {
          description: record.description,
          agent_type: record.agent_type,
          residency_state: record.residency_state,
          depth: record.depth,
          created_at: record.created_at,
          updated_at: record.updated_at,
        }),
  }
}

export function recordDetails(record: TaskRecord, mode: TaskToolMode): TaskToolDetails {
  const { task_id, ...rest } = recordSummary(record)
  return {
    ...rest,
    agentId: task_id,
    mode,
    subagent_type: record.agent_type,
    resolved_model: record.resolved_model,
    fallback_attempts: record.fallback_attempts,
  }
}

export function startedDetails(
  started: Extract<StartResult, { kind: "started" }>,
  params: SingleSpawnParams,
  executionMode: ExecutionMode,
): TaskToolDetails {
  return {
    agentId: started.task_id,
    status: started.status,
    mode: "spawn",
    task_summary: params.summary,
    name: started.name,
    subagent_type: params.preset,
    execution_mode: executionMode,
    model: params.model,
    resolved_model: started.resolved_model,
    queue_position: started.queue_position,
  }
}
