import type {
  TaskOutputDetails,
  TaskRecord,
  TaskRunStats,
  ToolProgressDetails,
} from "@rubato/senpi-task"
import { recordSummary } from "@rubato/senpi-task"

export type TaskLiveProgressSnapshot = ReturnType<typeof liveProgressSnapshot>

const MAX_CONTROL_MESSAGE_LENGTH = 32_000
const MAX_CONTROL_REASON_LENGTH = 2_000
const MAX_SNAPSHOT_TEXT_LENGTH = 32_000
const MAX_TASK_ID_LENGTH = 256
const MAX_TAIL_LINES = 1_000
const TASK_ID_PATTERN = /^st_[A-Za-z0-9_-]+$/u

export function taskSnapshot(
  record: TaskRecord,
  liveRunStats: TaskRunStats | undefined,
  liveProgress: TaskLiveProgressSnapshot | undefined,
) {
  const runStats = liveRunStats ?? record.run_stats
  const description = bounded(record.description, MAX_SNAPSHOT_TEXT_LENGTH)
  const finalResponse = bounded(record.final_response, MAX_SNAPSHOT_TEXT_LENGTH)
  const errorMessage = bounded(record.error_message, MAX_SNAPSHOT_TEXT_LENGTH)
  return {
    ...recordSummary(record, true),
    task_id: boundedRequired(record.task_id, MAX_TASK_ID_LENGTH),
    name: bounded(record.name, MAX_SNAPSHOT_TEXT_LENGTH).value,
    task_summary: bounded(record.task_summary, MAX_SNAPSHOT_TEXT_LENGTH).value,
    description: description.value,
    agent_type: bounded(record.agent_type, MAX_SNAPSHOT_TEXT_LENGTH).value,
    category: bounded(record.category, MAX_SNAPSHOT_TEXT_LENGTH).value,
    model: boundedRequired(record.model, MAX_SNAPSHOT_TEXT_LENGTH),
    ...(description.truncated ? { description_truncated: true } : {}),
    ...(record.child_session_id === undefined
      ? {}
      : { child_session_id: boundedRequired(record.child_session_id, MAX_TASK_ID_LENGTH) }),
    ...(runStats === undefined ? {} : { run_stats: runStats }),
    ...(finalResponse.value === undefined ? {} : { final_response: finalResponse.value }),
    ...(finalResponse.truncated ? { final_response_truncated: true } : {}),
    ...(errorMessage.value === undefined ? {} : { error_message: errorMessage.value }),
    ...(errorMessage.truncated ? { error_message_truncated: true } : {}),
    ...(liveProgress === undefined ? {} : { live_progress: liveProgress }),
  }
}

export function liveProgressSnapshot(details: ToolProgressDetails) {
  return {
    activity: details.progress.activity,
    started_at: details.progress.startedAt,
    ...(details.currentTool === undefined ? {} : { current_tool: details.currentTool }),
    ...(details.lastAssistantLine === undefined ? {} : { last_assistant_line: details.lastAssistantLine }),
    turns: details.turns,
    ...(details.toolCalls === undefined ? {} : { tool_calls: details.toolCalls }),
    ...(details.tokens === undefined ? {} : { total_tokens: details.tokens }),
    ...(details.outputTokens === undefined ? {} : { output_tokens: details.outputTokens }),
    ...(details.tokensPerSecond === undefined ? {} : { tokens_per_second: details.tokensPerSecond }),
  }
}

export function parseTaskSend(
  value: unknown,
): { readonly value: { readonly to: string; readonly message: string } } | { readonly error: string } {
  if (!isRecord(value)) return { error: "Request must be an object." }
  if (typeof value.to !== "string" || value.to.trim().length === 0) {
    return { error: "to is required." }
  }
  if (!validTaskId(value.to)) return { error: "to must be a task id of at most 256 characters." }
  if (typeof value.message !== "string" || value.message.trim().length === 0) {
    return { error: "message is required." }
  }
  if (value.message.length > MAX_CONTROL_MESSAGE_LENGTH) {
    return { error: `message must be at most ${MAX_CONTROL_MESSAGE_LENGTH} characters.` }
  }
  return { value: { to: value.to, message: value.message } }
}

export function parseTaskCancel(
  value: unknown,
):
  | { readonly value: { readonly task_id: string; readonly reason?: string } }
  | { readonly error: string } {
  if (!isRecord(value)) return { error: "Request must be an object." }
  if (typeof value.task_id !== "string" || value.task_id.trim().length === 0) {
    return { error: "task_id is required." }
  }
  if (!validTaskId(value.task_id)) return { error: "task_id must be a task id of at most 256 characters." }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return { error: "reason must be a string." }
  }
  if (typeof value.reason === "string" && value.reason.length > MAX_CONTROL_REASON_LENGTH) {
    return { error: `reason must be at most ${MAX_CONTROL_REASON_LENGTH} characters.` }
  }
  return {
    value: {
      task_id: value.task_id,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    },
  }
}

export function parseTaskOutput(
  value: unknown,
):
  | {
      readonly value: {
        readonly task_id: string
        readonly mode?: "status" | "tail" | "full"
        readonly tail_lines?: number
      }
    }
  | { readonly error: string } {
  if (!isRecord(value)) return { error: "Request must be an object." }
  if (typeof value.task_id !== "string" || value.task_id.trim().length === 0) {
    return { error: "task_id is required." }
  }
  if (!validTaskId(value.task_id)) return { error: "task_id must be a task id of at most 256 characters." }
  if (value.mode !== undefined && value.mode !== "status" && value.mode !== "tail" && value.mode !== "full") {
    return { error: "mode must be status, tail, or full." }
  }
  if (value.tail_lines !== undefined && (!Number.isInteger(value.tail_lines) || Number(value.tail_lines) < 1)) {
    return { error: "tail_lines must be a positive integer." }
  }
  if (typeof value.tail_lines === "number" && value.tail_lines > MAX_TAIL_LINES) {
    return { error: `tail_lines must be at most ${MAX_TAIL_LINES}.` }
  }
  return {
    value: {
      task_id: value.task_id,
      ...(value.mode === undefined ? {} : { mode: value.mode }),
      ...(value.tail_lines === undefined ? {} : { tail_lines: Number(value.tail_lines) }),
    },
  }
}

export function invalidArguments(reason: string) {
  return { kind: "invalid_arguments", reason } as const
}

export function boundedTaskOutput(details: TaskOutputDetails) {
  if (details.kind === "not_found") return { kind: "not_found", reason: "Task not found." } as const
  if (details.kind === "invalid_arguments") return details
  const snapshot = boundedOutputSnapshot(details.snapshot)
  if (details.kind === "status") return { kind: "status" as const, snapshot }
  const transcript = bounded(details.transcript, MAX_SNAPSHOT_TEXT_LENGTH)
  return {
    kind: details.kind,
    mode: details.mode,
    source: details.source,
    transcript: transcript.value ?? "",
    truncated: details.truncated || transcript.truncated,
    snapshot,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validTaskId(value: string): boolean {
  return value.length <= MAX_TASK_ID_LENGTH && TASK_ID_PATTERN.test(value)
}

function boundedOutputSnapshot(snapshot: Extract<TaskOutputDetails, { kind: "status" }>["snapshot"]) {
  const output = bounded(snapshot.output, MAX_SNAPSHOT_TEXT_LENGTH)
  const model = snapshot.model === undefined ? undefined : boundedRequired(snapshot.model, MAX_SNAPSHOT_TEXT_LENGTH)
  return {
    task_id: boundedRequired(snapshot.agentId, MAX_TASK_ID_LENGTH),
    status: snapshot.status,
    ...(model === undefined ? {} : { model }),
    ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
    ...(snapshot.effortSource === undefined ? {} : { effortSource: snapshot.effortSource }),
    ...(output.value === undefined ? {} : { output: output.value }),
    ...(output.truncated ? { output_truncated: true } : {}),
  }
}

function bounded(value: string | undefined, maximum: number) {
  if (value === undefined || value.length <= maximum) return { value, truncated: false }
  return { value: value.slice(0, maximum), truncated: true }
}

function boundedRequired(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum)
}
