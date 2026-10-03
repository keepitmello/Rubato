import { describe, expect, test } from "bun:test"

import type { ResolvedModelRecord } from "../../state"
import { createRuntimeFallbackSettings, type SenpiRetryFallbackSettings } from "./runtime-fallback-settings"

function retryOf(settings: ReturnType<typeof createRuntimeFallbackSettings>): SenpiRetryFallbackSettings {
  return settings.getSettings().retry as unknown as SenpiRetryFallbackSettings
}

describe("createRuntimeFallbackSettings", () => {
  test("#given no child fallback chain #when settings are created #then global model fallback is disabled", () => {
    // given / when
    const settings = createRuntimeFallbackSettings("vendor/primary", undefined)

    // then
    expect(retryOf(settings)).toEqual({ modelFallback: false })
  })

  test("#given an explicit child fallback chain #when settings are created #then only that chain is enabled", () => {
    // given / when
    const fallback: ResolvedModelRecord = {
      provider: "vendor",
      model_id: "fallback",
      display: "vendor/fallback",
      source: "model",
    }
    const settings = createRuntimeFallbackSettings("vendor/primary", [fallback])

    // then
    expect(retryOf(settings)).toEqual({
      modelFallback: true,
      fallbackChains: {
        "vendor/primary": ["vendor/fallback"],
      },
    })
  })
})
