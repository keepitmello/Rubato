import type {
  AgentEventListener,
  AgentSnapshot,
  ModelCatalog,
  ResolvedAgentSpec,
  Unsubscribe,
} from "./types"

export interface AgentHost {
  models(): ModelCatalog
  spawn(spec: ResolvedAgentSpec): Promise<AgentHandle>
}

export interface AgentHandle {
  readonly agentId: string
  send(message: string): Promise<void>
  output(): Promise<AgentSnapshot>
  cancel(): Promise<void>
  subscribe(listener: AgentEventListener): Unsubscribe
}
