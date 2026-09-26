import type { RubatoConfig } from "@rubato/config-core"

import type { DreamRung } from "./runner"

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

/** The category's models in fallback order: `model` first when set, then `models`. */
export function dreamLadder(config: RubatoConfig, category: string): DreamRung[] {
  const entry = config.categories?.[category]
  if (entry === undefined) return []
  const defaultThinking = thinkingOf(entry.reasoning)
  const rungs: DreamRung[] = []
  const push = (model: unknown, reasoning: unknown) => {
    if (typeof model !== "string" || !model.includes("/")) return
    if (rungs.some((rung) => rung.model === model)) return
    const thinking = thinkingOf(reasoning) ?? defaultThinking
    rungs.push(thinking === undefined ? { model } : { model, thinking })
  }
  push(entry.model, entry.reasoning)
  for (const item of entry.models ?? []) {
    if (typeof item === "string") push(item, undefined)
    else push(item.model, item.reasoning)
  }
  return rungs
}

function thinkingOf(reasoning: unknown): string | undefined {
  return typeof reasoning === "string" && THINKING.has(reasoning) ? reasoning : undefined
}
