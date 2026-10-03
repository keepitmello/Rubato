import { SettingsManager } from "@earendil-works/pi-coding-agent"

import type { ResolvedModelRecord } from "../../state"

// Senpi's in-session model fallback read these two retry keys. Stock pi has no model fallback and
// ignores them, so on a stock engine an in-process child does not switch models on a dead primary.
// The keys stay so an engine that ports the feature reads the same chain.
export type SenpiRetryFallbackSettings = {
  readonly modelFallback: boolean
  readonly fallbackChains?: Readonly<Record<string, readonly string[]>>
}

type StockSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>

export function createRuntimeFallbackSettings(
  selectedModel: string | undefined,
  fallbackModels: readonly ResolvedModelRecord[] | undefined,
): SettingsManager {
  const retry: SenpiRetryFallbackSettings =
    selectedModel === undefined || fallbackModels === undefined || fallbackModels.length === 0
      ? { modelFallback: false }
      : { modelFallback: true, fallbackChains: { [selectedModel]: fallbackModels.map(modelSelector) } }
  return SettingsManager.inMemory({ retry } as StockSettings)
}

function modelSelector(model: ResolvedModelRecord): string {
  const thinking = model.reasoning ?? model.reasoning_effort ?? model.variant
  return thinking === undefined
    ? `${model.provider}/${model.model_id}`
    : `${model.provider}/${model.model_id}:${thinking}`
}
