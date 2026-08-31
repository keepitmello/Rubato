import type { AgentToolResult, Theme, ThemeColor, ToolRenderResultOptions } from "@code-yeongyu/senpi"
import type { AgentSnapshot } from "@rubato/agent-core"

import {
  excerptRendererText,
  joinRendererTokens,
  linesComponent,
  normalizeRendererText,
  rendererVisibleWidth,
  statusThemeColor,
} from "../task/renderers"
import type { TaskOutputInput } from "./output"
import type { TaskOutputDetails } from "./types"

export type OutputRenderTheme = Pick<Theme, "fg">

type RenderComponent = {
  render(width: number): string[]
  invalidate(): void
}

type ResultRow = {
  readonly color: ThemeColor
  readonly text: string
}

const DEFAULT_TAIL_LINES = 60
const TARGET_EXCERPT_MAX = 56

export function renderTaskOutputCall(args: Partial<TaskOutputInput>, theme: OutputRenderTheme): RenderComponent {
  return {
    render: (width: number): string[] => linesComponent([theme.fg("toolTitle", taskOutputCallLine(args, width))]).render(width),
    invalidate: (): void => {},
  }
}

export function renderTaskOutputResult(
  result: AgentToolResult<TaskOutputDetails>,
  _options: ToolRenderResultOptions,
  theme: OutputRenderTheme,
): RenderComponent {
  const row = taskOutputResultRow(result.details)
  return linesComponent([theme.fg(row.color, normalizeRendererText(row.text))])
}

function taskOutputCallLine(args: Partial<TaskOutputInput>, width: number): string {
  const mode = args.mode ?? "status"
  const tail = mode === "tail" ? `tail_lines:${args.tail_lines ?? DEFAULT_TAIL_LINES}` : undefined
  const beforeTarget = "AgentOutput target:"
  const afterTarget = joinRendererTokens([`mode:${mode}`, "peek", tail])
  const available = Math.min(TARGET_EXCERPT_MAX, Math.max(0, width - rendererVisibleWidth(beforeTarget) - rendererVisibleWidth(afterTarget) - 1))
  const target = excerptRendererText(args.agentId ?? "<missing>", available)
  return joinRendererTokens([`${beforeTarget}${target}`, afterTarget])
}

function taskOutputResultRow(details: TaskOutputDetails): ResultRow {
  switch (details.kind) {
    case "status": {
      const model = details.snapshot.model === undefined ? undefined : `model:${normalizeRendererText(details.snapshot.model)}`
      const effort = details.snapshot.effort === undefined ? undefined : `effort:${details.snapshot.effort}`
      return {
        color: statusThemeColor(details.snapshot.status),
        text: joinRendererTokens([
          `AgentOutput ${details.snapshot.agentId}`,
          normalizeRendererText(details.snapshot.status),
          model,
          effort,
        ]),
      }
    }
    case "transcript":
      return {
        color: statusThemeColor(details.snapshot.status),
        text: joinRendererTokens([
          `AgentOutput transcript ${details.snapshot.agentId}`,
          `mode:${details.mode}`,
          `source:${details.source}`,
          details.truncated ? "truncated" : undefined,
        ]),
      }
    case "not_found":
      return { color: "error", text: notFoundRow(details) }
    case "invalid_arguments":
      return { color: "error", text: `AgentOutput invalid: ${details.reason}` }
    default:
      return assertNever(details)
  }
}

function notFoundRow(details: Extract<TaskOutputDetails, { readonly kind: "not_found" }>): string {
  const known = details.known_agents.length > 0 ? `known:${excerptRendererText(details.known_agents.join(","))}` : undefined
  return joinRendererTokens([`AgentOutput not found: ${details.reason}`, known])
}

export function taskOutputModelText(snapshot: AgentSnapshot): string {
  const model = snapshot.model === undefined ? undefined : normalizeRendererText(snapshot.model)
  const effort = snapshot.effort === undefined ? undefined : `effort ${snapshot.effort}`
  const details = [effort].filter((part) => part !== undefined)
  if (model === undefined) return details.length > 0 ? details.join(", ") : ""
  return `model ${model}${details.length > 0 ? ` (${details.join(", ")})` : ""}`
}

function assertNever(value: never): never {
  throw new Error(`Unhandled AgentOutput renderer variant: ${String(value)}`)
}
