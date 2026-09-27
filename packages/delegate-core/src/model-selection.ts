import {
  fuzzyMatchModel,
  normalizeModel,
  parseModelString,
  parseVariantFromModelID,
  transformModelForProvider,
} from "@rubato/model-core"

export { transformModelForProvider } from "@rubato/model-core"

export type DelegateFallbackEntry = {
  readonly providers: string[]
  readonly model: string
  readonly variant?: string
}

export type DelegateModelResolutionInput = {
  readonly userModel?: string
  readonly userFallbackModels?: readonly string[]
  readonly fallbackChain?: readonly DelegateFallbackEntry[]
  readonly availableModels: ReadonlySet<string>
  readonly systemDefaultModel?: string
}

export type DelegateModelResolutionResult =
  | { readonly model: string; readonly variant?: string; readonly fallbackEntry?: DelegateFallbackEntry; readonly matchedFallback?: boolean }
  | { readonly skipped: true }
  | undefined

export type DelegateModelResolutionDeps = {
  readonly connectedProviders: readonly string[] | null
  readonly hasProviderModelsCache: boolean
  readonly hasConnectedProvidersCache: boolean
  readonly log?: (message: string, metadata?: Record<string, unknown>) => void
}

function parseUserFallbackModel(fallbackModel: string): {
  readonly baseModel: string
  readonly providerHint?: string[]
  readonly variant?: string
} | undefined {
  const normalizedFallback = normalizeModel(fallbackModel)
  if (!normalizedFallback) {
    return undefined
  }

  const parsedFullModel = parseModelString(normalizedFallback)
  if (parsedFullModel) {
    return {
      baseModel: `${parsedFullModel.providerID}/${parsedFullModel.modelID}`,
      providerHint: [parsedFullModel.providerID],
      variant: parsedFullModel.variant,
    }
  }

  const parsedModel = parseVariantFromModelID(normalizedFallback)
  if (!parsedModel.modelID) {
    return undefined
  }

  return {
    baseModel: parsedModel.modelID,
    variant: parsedModel.variant,
  }
}

export function resolveModelForDelegateTask(
  input: DelegateModelResolutionInput,
  deps: DelegateModelResolutionDeps,
): DelegateModelResolutionResult {
  const userModel = normalizeModel(input.userModel)
  if (userModel) {
    const parsed = parseUserFallbackModel(userModel)
    const userResult = parsed?.variant
      ? { model: parsed.baseModel, variant: parsed.variant }
      : { model: userModel }

    const userFallbackModels = input.userFallbackModels
    if (
      input.availableModels.size > 0 &&
      userFallbackModels &&
      userFallbackModels.length > 0
    ) {
      const providerHint = parsed?.providerHint
      const primaryMatch = fuzzyMatchModel(userResult.model, new Set(input.availableModels), providerHint)
      if (!primaryMatch) {
        for (const fallbackModel of userFallbackModels) {
          const parsedFallback = parseUserFallbackModel(fallbackModel)
          if (!parsedFallback) continue
          const fbMatch = fuzzyMatchModel(
            parsedFallback.baseModel,
            new Set(input.availableModels),
            parsedFallback.providerHint,
          )
          if (fbMatch) {
            deps.log?.("[resolveModelForDelegateTask] user primary model unreachable; promoting user fallback_models entry", {
              userPrimary: userResult.model,
              selectedFallback: fbMatch,
            })
            return {
              model: fbMatch,
              variant: parsedFallback.variant,
              matchedFallback: true,
            }
          }
        }
      }
    }

    return userResult
  }

  const connectedProviders = input.availableModels.size === 0 ? deps.connectedProviders : null

  if (
    input.availableModels.size === 0 &&
    connectedProviders === null &&
    !deps.hasProviderModelsCache &&
    !deps.hasConnectedProvidersCache
  ) {
    return { skipped: true }
  }

  const userFallbackModels = input.userFallbackModels
  if (userFallbackModels && userFallbackModels.length > 0) {
    if (input.availableModels.size === 0) {
      for (const fallbackModel of userFallbackModels) {
        const parsedFallback = parseUserFallbackModel(fallbackModel)
        if (!parsedFallback) continue

        if (
          connectedProviders &&
          parsedFallback.providerHint &&
          !parsedFallback.providerHint.some((provider) => connectedProviders.includes(provider))
        ) {
          continue
        }

        return { model: parsedFallback.baseModel, variant: parsedFallback.variant, matchedFallback: true }
      }
    } else {
      for (const fallbackModel of userFallbackModels) {
        const parsedFallback = parseUserFallbackModel(fallbackModel)
        if (!parsedFallback) continue

        const match = fuzzyMatchModel(parsedFallback.baseModel, new Set(input.availableModels), parsedFallback.providerHint)
        if (match) {
          return { model: match, variant: parsedFallback.variant, matchedFallback: true }
        }
      }
    }
  }

  const fallbackChain = input.fallbackChain
  if (fallbackChain && fallbackChain.length > 0) {
    if (input.availableModels.size === 0) {
      if (connectedProviders) {
        const connectedSet = new Set(connectedProviders)
        for (const entry of fallbackChain) {
          for (const provider of entry.providers) {
            if (connectedSet.has(provider)) {
              const transformedModelId = transformModelForProvider(provider, entry.model)
              deps.log?.("[resolveModelForDelegateTask] fallback chain resolved via connected provider", {
                provider,
                model: entry.model,
              })
              return { model: `${provider}/${transformedModelId}`, variant: entry.variant, fallbackEntry: entry, matchedFallback: true }
            }
          }
        }
        deps.log?.("[resolveModelForDelegateTask] no connected provider found in fallback chain")
      } else {
        const first = fallbackChain[0]
        const provider = first?.providers?.[0]
        if (first && provider) {
          const transformedModelId = transformModelForProvider(provider, first.model)
          return { model: `${provider}/${transformedModelId}`, variant: first.variant, fallbackEntry: first, matchedFallback: true }
        }
      }
    } else {
      for (const [entryIndex, entry] of fallbackChain.entries()) {
        for (const provider of entry.providers) {
          const transformedModelId = transformModelForProvider(provider, entry.model)
          const fullModel = `${provider}/${transformedModelId}`
          const match = fuzzyMatchModel(fullModel, new Set(input.availableModels), [provider])
          if (match) {
            return { model: match, variant: entry.variant, fallbackEntry: entry, matchedFallback: true }
          }
        }

        const laterRungProviders = new Set(
          fallbackChain
            .slice(entryIndex + 1)
            .filter((candidate) => candidate.model === entry.model)
            .flatMap((candidate) => candidate.providers),
        )
        const crossProviderCandidates = new Set(
          [...input.availableModels].filter((model) => {
            const [provider] = model.split("/")
            return provider !== undefined && !laterRungProviders.has(provider)
          }),
        )
        const crossProviderMatch = fuzzyMatchModel(entry.model, crossProviderCandidates)
        if (crossProviderMatch) {
          return { model: crossProviderMatch, variant: entry.variant, fallbackEntry: entry, matchedFallback: true }
        }
      }
    }
  }

  const systemDefaultModel = normalizeModel(input.systemDefaultModel)
  if (systemDefaultModel) {
    return { model: systemDefaultModel }
  }

  return undefined
}
