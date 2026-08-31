import type { ModelCatalog, PresetCatalog } from "@rubato/agent-core"

import type { AgentDefinition } from "../../agents"

export function agentPresetCatalog(agents: Readonly<Record<string, AgentDefinition>>): PresetCatalog {
  return {
    get(name) {
      if (!Object.hasOwn(agents, name)) return undefined
      const agent = agents[name]
      if (agent === undefined || agent.disable === true) return undefined
      return {
        name: agent.name,
        model: agent.model ?? agent.name,
        ...(agent.prompt === undefined ? {} : { prompt: agent.prompt }),
      }
    },
  }
}

export function closedModelCatalog(): ModelCatalog {
  return { has: () => false }
}
