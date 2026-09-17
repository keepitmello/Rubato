import type { AgentToolResult, Theme, ThemeColor, ToolRenderResultOptions } from "@code-yeongyu/senpi"
import { truncateToWidth } from "@earendil-works/pi-tui"

import {
  excerptRendererPromptText,
  excerptRendererText,
  joinRendererTokens,
  linesComponent,
  normalizeRendererText,
  rendererVisibleWidth,
  statusThemeColor,
} from "../task/renderers"
import type { TaskCancelInput } from "./cancel"
import type { MemberScopedTaskSendInput, TaskSendInput } from "./send-schema"
import type { CancelResultDetails, SendResultDetails } from "./types"

export type ControlRenderTheme = Pick<Theme, "fg" | "italic">

type RenderComponent = {
  render(width: number): string[]
  invalidate(): void
}

type ResultRow = {
  readonly color: ThemeColor
  readonly text: string
}

const MESSAGE_EXCERPT_MAX = 56
const REASON_EXCERPT_MAX = 40
const ELLIPSIS = "..."
const MIN_MEANINGFUL_TRUNCATED_EXCERPT_WIDTH = 8

export function renderTaskSendCall(args: Partial<TaskSendInput>, theme: ControlRenderTheme): RenderComponent {
  return widthComponent((width) => theme.fg("toolTitle", taskSendCallLine(args, theme, width)))
}

export function renderMemberScopedTaskSendCall(args: Partial<MemberScopedTaskSendInput>, theme: ControlRenderTheme): RenderComponent {
  return renderTaskSendCall(args, theme)
}

export function renderTaskSendResult(
  result: AgentToolResult<SendResultDetails>,
  _options: ToolRenderResultOptions,
  theme: ControlRenderTheme,
): RenderComponent {
  const row = taskSendResultRow(result.details)
  return linesComponent([theme.fg(row.color, normalizeRendererText(row.text))])
}

export function renderTaskCancelCall(args: Partial<TaskCancelInput>, theme: ControlRenderTheme): RenderComponent {
  return widthComponent((width) => theme.fg("warning", taskCancelCallLine(args, theme, width)))
}

export function renderTaskCancelResult(
  result: AgentToolResult<CancelResultDetails>,
  _options: ToolRenderResultOptions,
  theme: ControlRenderTheme,
): RenderComponent {
  const row = taskCancelResultRow(result.details)
  return linesComponent([theme.fg(row.color, normalizeRendererText(row.text))])
}

function widthComponent(renderLine: (width: number) => string): RenderComponent {
  return {
    render: (width: number): string[] => [truncateToWidth(renderLine(width), width, ELLIPSIS)],
    invalidate: (): void => {},
  }
}

function taskSendCallLine(args: Partial<TaskSendInput>, theme: ControlRenderTheme, width: number): string {
  const base = joinRendererTokens([
    "AgentSend",
    `agentId:${normalizeRendererText(args.agentId ?? "<missing>")}`,
  ])
  if (typeof args.message === "string") return withExcerpt(base, "message", args.message, theme, width)
  return base
}

function taskCancelCallLine(args: Partial<TaskCancelInput>, _theme: ControlRenderTheme, _width: number): string {
  const target = normalizeRendererText(args.agentId ?? "<missing>")
  return joinRendererTokens(["AgentCancel", `target:${target}`])
}

function withExcerpt(
  base: string,
  label: string,
  value: string,
  theme: ControlRenderTheme,
  width: number,
): string {
  const prefix = joinRendererTokens([base, `${label}:`])
  const quoteOverhead = 2
  const maxExcerpt = label === "reason" ? REASON_EXCERPT_MAX : MESSAGE_EXCERPT_MAX
  const normalized = normalizeRendererText(value)
  if (normalized.length === 0) return base
  const available = Math.min(maxExcerpt, Math.max(0, width - rendererVisibleWidth(prefix) - quoteOverhead))
  if (rendererVisibleWidth(normalized) > available && available < MIN_MEANINGFUL_TRUNCATED_EXCERPT_WIDTH) return base
  const excerpt = label === "message"
    ? excerptRendererPromptText(normalized, available)
    : excerptRendererText(normalized, available)
  return `${prefix}${theme.italic(`"${excerpt}"`)}`
}

function taskSendResultRow(details: SendResultDetails): ResultRow {
  switch (details.kind) {
    case "steered":
      return {
        color: statusThemeColor(details.status),
        text: `AgentSend delivered ${details.agentId} as ${details.delivered} (${details.status})`,
      }
    case "revived":
      return { color: "success", text: `AgentSend revived ${details.agentId} epoch ${details.run_epoch}` }
    case "queued":
      return { color: "muted", text: `AgentSend queued ${details.agentId} position ${details.queue_position}` }
    case "capacity_deferred":
      return { color: "warning", text: `AgentSend deferred ${details.agentId}: ${details.reason}` }
    case "not_continuable":
      return { color: "warning", text: `AgentSend not continuable ${details.agentId}: ${details.reason} ${details.suggestion}` }
    case "one_shot_agent":
      return { color: "error", text: `AgentSend denied ${details.agentId} one-shot:${details.agent}` }
    case "scope_denied":
      return { color: "error", text: `AgentSend denied ${details.agentId} owner:${details.owning_session_id}` }
    case "not_found":
      return { color: "error", text: notFoundText(details) }
    case "invalid_arguments":
      return { color: "error", text: `AgentSend invalid: ${details.reason}` }
    case "team_message":
      return teamMessageRow(details.team)
    case "shutdown_requested":
      return { color: "warning", text: `AgentSend shutdown requested ${details.team_run_id} member:${details.member}` }
    case "shutdown_responded":
      return {
        color: details.approved ? "success" : "warning",
        text: `AgentSend shutdown ${details.approved ? "approved" : "rejected"} ${details.team_run_id} member:${details.member}`,
      }
    case "shutdown_failed":
      return {
        color: "error",
        text: `AgentSend shutdown ${details.operation} failed ${details.team_run_id} member:${details.member}: ${details.reason}`,
      }
    default:
      return assertNever(details)
  }
}

function notFoundText(details: Extract<SendResultDetails, { readonly kind: "not_found" }>): string {
  if (details.known_agents.length === 0) return `AgentSend not found: ${details.reason}`
  return `AgentSend not found: ${details.reason} known:${details.known_agents.join(",")}`
}

function teamMessageRow(details: Extract<SendResultDetails, { readonly kind: "team_message" }>["team"]): ResultRow {
  switch (details.kind) {
    case "to_lead":
      return { color: "success", text: `AgentSend team message ${details.message_id} enqueued to lead` }
    case "to_members":
      return {
        color: "success",
        text: `AgentSend team message ${details.message_id} enqueued to ${details.recipients.length} member(s)`,
      }
    case "recipient_backpressure":
    case "invalid_recipient":
    case "payload_too_large":
    case "broadcast_denied":
    case "team_deleting":
      return { color: "error", text: `AgentSend team ${details.kind} to:${details.to}: ${details.reason}` }
    default:
      return assertNever(details)
  }
}

function taskCancelResultRow(details: CancelResultDetails): ResultRow {
  switch (details.kind) {
    case "cancelled":
      return {
        color: statusThemeColor(details.status),
        text: `AgentCancel cancelled ${details.agentId} (${details.previous_status} -> ${details.status})`,
      }
    case "noop":
      return { color: statusThemeColor(details.status), text: `AgentCancel no change ${details.agentId} (${details.status}): ${details.reason}` }
    case "not_found":
      return { color: "error", text: `AgentCancel not found: ${details.reason}` }
    case "invalid_arguments":
      return { color: "error", text: `AgentCancel invalid: ${details.reason}` }
    default:
      return assertNever(details)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled control renderer variant: ${String(value)}`)
}
