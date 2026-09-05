import type { SettingsManager } from "@code-yeongyu/senpi"

import { tryGetStockSdkSync } from "../../pi-sdk/stock-runtime.ts"
import type { ResolvedModelRecord } from "../../state"

type RetryFallbackSettings = {
  readonly modelFallback: boolean
  readonly chains: Readonly<Record<string, readonly string[]>>
}

type FallbackSettings = SettingsManager & {
  getRetryFallbackSettings(): RetryFallbackSettings
}

export function createRuntimeFallbackSettings(
  selectedModel: string | undefined,
  fallbackModels: readonly ResolvedModelRecord[] | undefined,
): FallbackSettings {
  const retry = selectedModel === undefined || fallbackModels === undefined || fallbackModels.length === 0
    ? { modelFallback: false as const }
    : {
        modelFallback: true as const,
        fallbackChains: {
          [selectedModel]: fallbackModels.map(modelSelector),
        },
      }
  const chains = "fallbackChains" in retry ? retry.fallbackChains : {}
  const view: RetryFallbackSettings = {
    modelFallback: retry.modelFallback,
    chains,
  }
  const stock = tryGetStockSdkSync()?.SettingsManager.inMemory({ retry })
  if (stock !== undefined && typeof stock === "object" && stock !== null) {
    const inner = stock as FallbackSettings
    if (typeof inner.getRetryFallbackSettings === "function") return inner
    inner.getRetryFallbackSettings = () => view
    return inner
  }
  return {
    getRetryFallbackSettings: () => view,
  } as FallbackSettings
}

function modelSelector(model: ResolvedModelRecord): string {
  const thinking = model.reasoning ?? model.reasoning_effort ?? model.variant
  return thinking === undefined
    ? `${model.provider}/${model.model_id}`
    : `${model.provider}/${model.model_id}:${thinking}`
}
