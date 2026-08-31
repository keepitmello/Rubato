import { AGENT_EFFORTS, type AgentEffort } from "@rubato/agent-core"

import { clampTaskSummary } from "../../task-summary"
import type { TaskToolParamsStatic } from "./params"

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonBlankText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function effort(value: unknown): AgentEffort | undefined {
  return AGENT_EFFORTS.find((entry) => entry === value)
}

function summaryText(value: unknown): string | undefined {
  return clampTaskSummary(typeof value === "string" ? value : undefined)
}

export function normalizeTaskToolArguments(raw: unknown): TaskToolParamsStatic {
  if (!isRecord(raw)) return { prompt: "" }

  const prompt = typeof raw.prompt === "string" ? raw.prompt : ""
  const model = identifier(raw.model)
  const preset = identifier(raw.preset)
  const normalizedEffort = effort(raw.effort)
  const summary = summaryText(raw.summary) ?? summaryText(raw.task_summary)

  return {
    prompt,
    ...(model === undefined ? {} : { model }),
    ...(preset === undefined ? {} : { preset }),
    ...(normalizedEffort === undefined ? {} : { effort: normalizedEffort }),
    ...(summary === undefined ? {} : { summary }),
  }
}
