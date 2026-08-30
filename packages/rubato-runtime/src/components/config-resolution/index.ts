import {
  loadRubatoConfig,
  resolveModelReferences,
  type LoadRubatoConfigOptions,
  type LoadRubatoConfigResult,
  type RubatoConfig,
  type RubatoConfigDiagnostic,
  type RubatoModelReferenceDiagnostic,
} from "@rubato/config-core"

export type SenpiConfigDiagnostic = RubatoConfigDiagnostic | RubatoModelReferenceDiagnostic

export type SenpiRubatoConfigResult = Omit<LoadRubatoConfigResult, "config" | "diagnostics"> & {
  readonly config: RubatoConfig
  readonly diagnostics: readonly SenpiConfigDiagnostic[]
}

/** Loads the profile-selected Senpi view and expands shared model catalog entries for task consumers. */
export function loadSenpiRubatoConfig(options: LoadRubatoConfigOptions = {}): SenpiRubatoConfigResult {
  const { harness: _ignoredHarness, ...loadOptions } = options
  const loaded = loadRubatoConfig({ ...loadOptions, harness: "senpi" })
  const resolvedModels = resolveModelReferences(loaded.config)
  return {
    ...loaded,
    config: resolvedModels.view,
    diagnostics: [...loaded.diagnostics, ...resolvedModels.diagnostics],
  }
}
