import type { ResolvedModelRecord, ResolvedModelSource } from "./state"

export type ModelChainCandidate = {
  readonly model: string
  readonly variant?: string
  readonly reasoningEffort?: string
}

type BuildModelChainOptions = {
  readonly candidates: readonly ModelChainCandidate[]
  readonly selectedModel: string
  readonly availableModels?: ReadonlySet<string>
  readonly source: ResolvedModelSource
}

export type RuntimeModelChain = {
  readonly requested_model?: ResolvedModelRecord
  readonly fallback_models?: readonly ResolvedModelRecord[]
}

export function buildRuntimeModelChain(options: BuildModelChainOptions): RuntimeModelChain {
  const candidates = deduplicateCandidates(options.candidates)
  const requestedModel = toResolvedModelRecord(candidates[0], options.source)
  if (requestedModel === undefined) return {}

  const selectedIndex = candidates.findIndex((candidate) => candidate.model === options.selectedModel)
  const fallbackModels = selectedIndex === -1
    ? []
    : candidates
      .slice(selectedIndex + 1)
      .filter((candidate) =>
        options.availableModels === undefined || options.availableModels.has(candidate.model)
      )
      .map((candidate) => toResolvedModelRecord(candidate, options.source))
      .filter((candidate): candidate is ResolvedModelRecord => candidate !== undefined)

  return {
    requested_model: requestedModel,
    ...(fallbackModels.length > 0 ? { fallback_models: fallbackModels } : {}),
  }
}

function deduplicateCandidates(candidates: readonly ModelChainCandidate[]): readonly ModelChainCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.model)) return false
    seen.add(candidate.model)
    return true
  })
}

function toResolvedModelRecord(
  candidate: ModelChainCandidate | undefined,
  source: ResolvedModelSource,
): ResolvedModelRecord | undefined {
  if (candidate === undefined) return undefined
  const separatorIndex = candidate.model.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === candidate.model.length - 1) return undefined

  const provider = candidate.model.slice(0, separatorIndex)
  const modelId = candidate.model.slice(separatorIndex + 1)
  return {
    source,
    provider,
    model_id: modelId,
    display: `${provider}/${modelId}`,
    ...(candidate.variant !== undefined ? { variant: candidate.variant } : {}),
    ...(candidate.reasoningEffort !== undefined
      ? { reasoning_effort: candidate.reasoningEffort }
      : {}),
  }
}
