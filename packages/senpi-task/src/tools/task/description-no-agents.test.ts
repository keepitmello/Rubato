import { describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import type { AgentDefinition } from "../../agents"
import { buildTaskToolDescription } from "./description"

const config: RubatoConfig = { categories: { grok: { description: "Fast lane" } }, agents: {} }
const noAgents: Readonly<Record<string, AgentDefinition>> = {}

describe("buildTaskToolDescription with zero loaded agents", () => {
  test("#given no loaded agents #when built #then the preset route is not advertised", () => {
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    expect(description).not.toContain("subagent_type")
    expect(description).not.toContain("Available presets")
    expect(description).not.toContain("none loaded")
    expect(description).toContain("No presets are currently loaded")
  })

  test("#given no loaded agents #when built #then no agent name is offered as an example", () => {
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    expect(description).not.toContain("momus")
    expect(description).not.toContain("undefined")
  })

  test("#given no loaded agents #when built #then the target rule accepts model only", () => {
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    expect(description).toContain("provide `model`")
    expect(description).not.toContain("category")
  })

  test("#given agents are loaded again #when built #then the preset route returns", () => {
    const agents: Readonly<Record<string, AgentDefinition>> = {
      explore: { name: "explore", description: "Codebase search" },
    }

    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    expect(description).toContain("`preset` invokes a loaded named agent")
    expect(description).toContain("explore")
    expect(description).toContain("Available presets")
  })
})
