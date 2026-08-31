import type { Theme } from "@code-yeongyu/senpi"
import { truncateToWidth } from "@earendil-works/pi-tui"

import { formatTargetIdentity } from "../../status-line"
import {
  ELLIPSIS,
  excerptRendererPromptText,
  joinRendererTokens,
  optionalRendererText,
  rendererVisibleWidth,
} from "../../renderer-text"

const TASK_PROMPT_EXCERPT_WIDTH = 80

export type TaskCallArgs = {
  readonly prompt?: string
  readonly summary?: string
  readonly task_summary?: string
  readonly preset?: string
  readonly model?: string
}

export function formatTaskTarget(args: Pick<TaskCallArgs, "preset">): string {
  return formatTargetIdentity({ agentType: args.preset }) ?? "task"
}

export function formatTaskMode(): string {
  return "background"
}

export function taskCallLines(args: TaskCallArgs): readonly string[] {
  return [taskCallLine(args, formatTaskMode())]
}

export function renderTaskCallLines(
  args: TaskCallArgs,
  theme: Pick<Theme, "italic">,
  width?: number,
): readonly string[] {
  const plainMode = formatTaskMode()
  const mode = theme.italic(plainMode)
  if (width === undefined) return [taskCallLine(args, mode)]
  return [taskCallLineForWidth(args, mode, plainMode, width)]
}

// The call row is intentionally label-only: the category/model context lives in the live progress
// line (details.progress.activity) and the final result row, so repeating it here wasted the width
// that the excerpt needs. The task_summary, when present, replaces the truncated prompt so the row
// reads as WHAT was delegated instead of the prompt's first words.
function callRowText(args: TaskCallArgs): string | undefined {
  return optionalRendererText(args.summary) ?? optionalRendererText(args.task_summary) ?? optionalRendererText(args.prompt)
}

function taskCallLine(args: TaskCallArgs, mode: string): string {
  return joinRendererTokens(["Agent", promptToken(callRowText(args)), mode])
}

function taskCallLineForWidth(args: TaskCallArgs, mode: string, plainMode: string, width: number): string {
  if (width <= 0) return ""
  const fixedWidth = rendererVisibleWidth("Agent") + rendererVisibleWidth(plainMode) + 4
  const available = Math.min(TASK_PROMPT_EXCERPT_WIDTH, Math.max(0, width - fixedWidth))
  const normalized = callRowText(args)
  const prompt = normalized === undefined || available <= 0
    ? undefined
    : `"${excerptRendererPromptText(normalized, available)}"`
  return truncateToWidth(joinRendererTokens(["Agent", prompt, mode]), width, ELLIPSIS)
}

function promptToken(text: string | undefined): string | undefined {
  const normalized = optionalRendererText(text)
  return normalized === undefined ? undefined : `"${excerptRendererPromptText(normalized, TASK_PROMPT_EXCERPT_WIDTH)}"`
}
