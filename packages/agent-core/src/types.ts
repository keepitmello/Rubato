import type { EffortSource as ModelEffortSource } from "@rubato/model-core"

export const AGENT_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

export type EffortSource = ModelEffortSource

export type AgentRequest = {
  readonly prompt: string
  readonly model?: string
  readonly preset?: string
  readonly effort?: AgentEffort
  readonly summary?: string
}

export type AgentPreset = {
  readonly name: string
  readonly model: string
  readonly prompt?: string
}

export type ModelCatalog = {
  has(model: string): boolean
}

export type PresetCatalog = {
  get(name: string): AgentPreset | undefined
}

export type ResolvedAgentSpec = {
  readonly prompt: string
  readonly model: string
  readonly effort?: AgentEffort
  readonly effortSource?: EffortSource
  readonly preset?: string
  readonly summary?: string
  readonly instructions?: string
}

export type AgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost"

export type AgentSnapshot = {
  readonly agentId: string
  readonly status: AgentStatus
  readonly model?: string
  readonly effort?: AgentEffort
  readonly effortSource?: EffortSource
  readonly output?: string
}

export type AgentEvent =
  | { readonly type: "started"; readonly agentId: string }
  | { readonly type: "updated"; readonly agentId: string; readonly snapshot: AgentSnapshot }
  | { readonly type: "completed"; readonly agentId: string; readonly snapshot: AgentSnapshot }
  | { readonly type: "failed"; readonly agentId: string; readonly error: AgentError }
  | { readonly type: "cancelled"; readonly agentId: string }

export type AgentErrorCode = "invalid_request" | "model_unavailable" | "preset_unavailable"

export type AgentError =
  | { readonly code: "invalid_request"; readonly message: string }
  | { readonly code: "model_unavailable"; readonly message: string; readonly model: string }
  | { readonly code: "preset_unavailable"; readonly message: string; readonly preset: string }

export type AgentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentError }

export type Unsubscribe = () => void
export type AgentEventListener = (event: AgentEvent) => void
