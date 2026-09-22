import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomically } from "@rubato/utils"

import { messageability } from "../state"
import type { ResolvedModelRecord, TaskRecord } from "../state"
import { excerptRendererPromptText, normalizeRendererText } from "../tools/task/renderers"
import type { CompletionDetails, ParentNotifierMessage } from "./types"

export const FINAL_RESPONSE_TRANSPORT_LIMIT = 32_000

export type BuildDetailsOptions = {
  readonly tokens?: number
  readonly stateDir?: string
}

function visibleModel(record: ResolvedModelRecord | undefined): Omit<ResolvedModelRecord, "source"> | undefined {
  if (record === undefined) return undefined
  const { source: _source, ...visible } = record
  return visible
}

export function buildCompletionDetails(record: TaskRecord, options: BuildDetailsOptions = {}): CompletionDetails {
  const finalResponse = finalResponseForNotification(record, options.stateDir)
  const runStats = record.run_stats
  const tokens = options.tokens ?? runStats?.total_tokens
  const base: CompletionDetails = {
    agentId: record.task_id,
    name: record.name ?? record.task_id,
    status: record.status,
    ...(record.preset === undefined ? {} : { preset: record.preset }),
    model: record.model,
    ...(record.requested_model === undefined
      ? {}
      : { requested_model: visibleModel(record.requested_model) }),
    ...(record.fallback_models === undefined
      ? {}
      : { fallback_models: record.fallback_models.map((model) => visibleModel(model)!) }),
    ...(record.resolved_model === undefined ? {} : { resolved_model: visibleModel(record.resolved_model) }),
    duration_ms: durationMs(record),
    ...(runStats === undefined ? {} : { run_stats: runStats }),
    final_response: finalResponse.text,
    ...(finalResponse.file === undefined ? {} : { final_response_file: finalResponse.file }),
    continuation_hint: continuationHint(record),
  }
  return tokens === undefined ? base : { ...base, tokens }
}

export function buildCompletionMessage(details: readonly CompletionDetails[]): ParentNotifierMessage {
  return {
    customType: "rubato.task.completion",
    // Status pointer only: status, name, id and the result file path. The body lives in that file;
    // `details` carries it for the TUI only (senpi's convertToLlm sends `content` alone for role
    // "custom"), so inlining it in `content` is what used to overflow the parent's model context.
    content: completionMessageLines(details).join("\n"),
    display: false,
    details,
  }
}

export function completionMessageLines(details: readonly CompletionDetails[], width?: number): readonly string[] {
  return details.flatMap((detail) => completionDetailLines(detail, width))
}

// EVERY delegated result is recoverable from a file, not only the ones that overflowed the transport
// limit: the parent reads the file path instead of pulling the body into its context. `details.text`
// stays capped so the display payload cannot grow without bound.
function finalResponseForNotification(record: TaskRecord, stateDir: string | undefined): { readonly text: string; readonly file?: string } {
  const source = record.final_response ?? record.error_message ?? ""
  const text = source.length <= FINAL_RESPONSE_TRANSPORT_LIMIT
    ? source
    : source.slice(0, FINAL_RESPONSE_TRANSPORT_LIMIT)
  if (stateDir === undefined) return { text }
  return { text, file: writeCompletionResultFile(stateDir, record.task_id, record.notification.run_epoch, source) }
}

/**
 * Persist one delegated result body under the state dir and return its absolute path. Called for
 * every terminal child (including the team members whose individual notification is silenced), so a
 * result stays readable even when no batch ever completes.
 */
export function writeCompletionResultFile(stateDir: string, taskId: string, epoch: number, body: string): string {
  // A continuation has a new epoch. Its output must never change an already-issued result pointer.
  const directory = join(stateDir, "completion-results", taskId)
  const path = join(directory, `${epoch}.txt`)
  mkdirSync(directory, { recursive: true })
  writeFileAtomically(path, body)
  return path
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
  const lines = [width === undefined ? line : excerptRendererPromptText(line, width)]
  // The pointer is what the parent acts on; without it the notification is a wake with no address.
  if (detail.final_response_file === undefined) return lines
  const result = `result ${normalizeRendererText(detail.final_response_file)}`
  return [...lines, width === undefined ? result : excerptRendererPromptText(result, width)]
}
