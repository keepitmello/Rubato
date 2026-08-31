import { isClaudeFable5Model, isClaudeOpus5Model, isGrok46Model } from "./model-family-detectors"

export const MODEL_DEFAULT_EFFORT_SOURCE = "model-default" as const
export const MANUAL_OVERRIDE_EFFORT_SOURCE = "manual-override" as const

export const EFFORT_SOURCES = [MODEL_DEFAULT_EFFORT_SOURCE, MANUAL_OVERRIDE_EFFORT_SOURCE] as const
export type EffortSource = (typeof EFFORT_SOURCES)[number]

export type ConfiguredModelEffort = "medium" | "high"

export type ResolvedModelEffort = {
  readonly effort: string
  readonly effortSource: EffortSource
}

function providerAndId(model: string): { readonly provider: string; readonly id: string } {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    return { provider: "", id: model.trim().toLowerCase() }
  }
  return {
    provider: model.slice(0, slash).toLowerCase(),
    id: model.slice(slash + 1).toLowerCase(),
  }
}

function isSolModel(model: string): boolean {
  const id = providerAndId(model).id
  return id.startsWith("gpt-5.6-sol") || id.startsWith("gpt-5-6-sol")
}

function isAntigravityFlash(model: string): boolean {
  const { provider, id } = providerAndId(model)
  return provider === "google-antigravity" && id === "gemini-3.7-flash"
}

/**
 * Seeded model-owned effort. Callers omit effort unless they need a manual override.
 *
 * [Assumption] `google-antigravity/gemini-3.7-flash` starts at medium because Rubato is
 * not using `low` as a seeded default.
 */
export function configuredModelEffort(model: string): ConfiguredModelEffort | undefined {
  if (typeof model !== "string" || model.trim().length === 0) return undefined
  if (isSolModel(model) || isAntigravityFlash(model)) return "medium"
  if (isClaudeOpus5Model(model) || isClaudeFable5Model(model) || isGrok46Model(model)) return "high"
  return undefined
}

export function resolveModelEffort(model: string, explicit?: string): ResolvedModelEffort | undefined {
  if (typeof explicit === "string" && explicit.length > 0) {
    return { effort: explicit, effortSource: MANUAL_OVERRIDE_EFFORT_SOURCE }
  }
  const effort = configuredModelEffort(model)
  if (effort === undefined) return undefined
  return { effort, effortSource: MODEL_DEFAULT_EFFORT_SOURCE }
}
