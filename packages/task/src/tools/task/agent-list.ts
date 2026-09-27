import type { AgentDefinition } from "../../agents"
import type { TaskAgentInfo } from "./types"

function ownValue<TValue>(record: Readonly<Record<string, TValue>>, key: string): TValue | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

// Agent types surfaced from the todo-5 loader; disabled definitions are hidden.
export function listTaskAgents(agents: Readonly<Record<string, AgentDefinition>>): readonly TaskAgentInfo[] {
  return Object.keys(agents)
    .sort()
    .map((name) => ownValue(agents, name))
    .filter((agent): agent is AgentDefinition => agent !== undefined && agent.disable !== true)
    .map((agent) => (agent.description !== undefined ? { name: agent.name, description: agent.description } : { name: agent.name }))
}
