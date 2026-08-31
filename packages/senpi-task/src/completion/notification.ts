import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { messageability } from "../state"
import type { TaskRecord } from "../state"
import { excerptRendererPromptText, normalizeRendererText } from "../tools/task/renderers"
import type { CompletionDetails, ParentNotifierMessage } from "./types"

export const FINAL_RESPONSE_TRANSPORT_LIMIT = 32_000

export type BuildDetailsOptions = {
  readonly tokens?: number
  readonly stateDir?: string
}

export function buildCompletionDetails(record: TaskRecord, options: BuildDetailsOptions = {}): CompletionDetails {
  const finalResponse = finalResponseForNotification(record, options.stateDir)
  const runStats = record.run_stats
  const tokens = options.tokens ?? runStats?.total_tokens
  const base: CompletionDetails = {
    agentId: record.task_id,
    name: record.name ?? record.task_id,
    status: record.status,
    ...(record.category === undefined ? {} : { category: record.category }),
    ...(record.agent_type === undefined ? {} : { agent_type: record.agent_type }),
    model: record.model,
    ...(record.requested_model === undefined
      ? {}
      : { requested_model: record.requested_model }),
    ...(record.fallback_models === undefined
      ? {}
      : { fallback_models: record.fallback_models }),
    ...(record.resolved_model === undefined ? {} : { resolved_model: record.resolved_model }),
    duration_ms: durationMs(record),
    ...(runStats === undefined ? {} : { run_stats: runStats }),
    final_response: finalResponse.text,
    ...(finalResponse.file === undefined ? {} : { final_response_file: finalResponse.file }),
    continuation_hint: continuationHint(record),
    ...(record.owner?.kind === "dag"
      ? { dag: { run_id: record.owner.runId, node_id: record.owner.nodeId } }
      : {}),
  }
  return tokens === undefined ? base : { ...base, tokens }
}

export function buildCompletionMessage(details: readonly CompletionDetails[]): ParentNotifierMessage {
  return {
    customType: "senpi-task.completion",
    // Status ping only. The child's body stays on `details` for the TUI; inlining it here
    // overflowed the parent's model context. Owners report via team_send; AgentOutput peeks raw.
    content: completionMessageLines(details).join("\n"),
    display: false,
    details,
  }
}

export function completionMessageLines(details: readonly CompletionDetails[], width?: number): readonly string[] {
  return details.flatMap((detail) => completionDetailLines(detail, width))
}

function finalResponseForNotification(record: TaskRecord, stateDir: string | undefined): { readonly text: string; readonly file?: string } {
  const source = record.final_response ?? record.error_message ?? ""
  if (source.length <= FINAL_RESPONSE_TRANSPORT_LIMIT) return { text: source }
  if (stateDir === undefined) return { text: source.slice(0, FINAL_RESPONSE_TRANSPORT_LIMIT) }

  const path = completionSpillPath(stateDir, record.task_id)
  mkdirSync(join(stateDir, "completion-results"), { recursive: true })
  writeFileSync(path, source, "utf8")
  return { text: source.slice(0, FINAL_RESPONSE_TRANSPORT_LIMIT), file: `local://${path}` }
}

function completionSpillPath(stateDir: string, taskId: string): string {
  return join(stateDir, "completion-results", `${taskId}.txt`)
}

function durationMs(record: TaskRecord): number {
  const started = Date.parse(record.created_at)
  const ended = Date.parse(record.updated_at)
  if (Number.isNaN(started) || Number.isNaN(ended)) return 0
  return Math.max(0, ended - started)
}

function continuationHint(record: TaskRecord): string {
  const mode = messageability(record.status, record.residency_state)
  if (mode === "not-continuable") return ""
  return `Use AgentSend({ agentId: "${record.task_id}", message: "..." }) to continue.`
}

function completionDetailLines(detail: CompletionDetails, width: number | undefined): readonly string[] {
  const status = normalizeRendererText(detail.status)
  const name = normalizeRendererText(detail.name)
  const id = normalizeRendererText(detail.agentId)
  const line = name === id ? `${status} ${id}` : `${status} ${name} ${id}`
  return [width === undefined ? line : excerptRendererPromptText(line, width)]
}
