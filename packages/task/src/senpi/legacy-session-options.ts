import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"

// Senpi's createAgentSession accepted `authStorage` and `modelRegistry`, and its ModelRegistry
// exposed `authStorage` and `modelRuntime`. Stock pi has none of them: createAgentSession takes a
// `modelRuntime` only, and ModelRegistry keeps its runtime private. The task layer still carries
// these fields so the stock child adapter in @rubato/runtime (createStockInProcessSessionAdapter)
// can strip them and fail closed when a caller sends auth without a ModelRuntime.
export type LegacyAuthStorage = unknown

export type ChildModelRegistry = ModelRegistry & {
  readonly authStorage?: LegacyAuthStorage
  readonly modelRuntime?: ModelRuntime
}

export type LegacyChildSessionFields = {
  readonly authStorage?: LegacyAuthStorage
  readonly modelRegistry?: ChildModelRegistry
}
