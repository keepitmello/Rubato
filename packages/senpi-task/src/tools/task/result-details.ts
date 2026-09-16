import type { ExecutionMode, StartResult } from "../../manager"
import type { ResolvedModelRecord, TaskRecord } from "../../state"
import type { TaskToolDetails, TaskToolMode } from "./types"

export type SingleSpawnParams = {
  readonly prompt: string
  readonly summary?: string
  readonly preset?: string
  readonly model?: string
}

function visibleModel(record: ResolvedModelRecord | undefined): Omit<ResolvedModelRecord, "source"> | undefined {
  if (record === undefined) return undefined
  const { source: _source, ...visible } = record
  return visible
}

export function recordSummary(record: TaskRecord, includeLifecycle?: boolean) {
  return {
    task_id: record.task_id,
    status: record.status,
    task_summary: record.task_summary,
    name: record.name,
    preset: record.preset,
    execution_mode: record.execution_mode,
    model: record.model,
    ...(record.run_stats === undefined ? {} : { run_stats: record.run_stats }),
    ...(includeLifecycle && {
          description: record.description,
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
    resolved_model: visibleModel(record.resolved_model),
    fallback_attempts: record.fallback_attempts?.map((attempt) => visibleModel(attempt)!),
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
    preset: params.preset,
    execution_mode: executionMode,
    model: params.model,
    resolved_model: visibleModel(started.resolved_model),
    queue_position: started.queue_position,
  }
}
