import { describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import type { AgentDefinition } from "../../agents"
import { buildTaskToolDescription } from "./description"

// Every other description test passes a non-empty agents record, so the zero-agent installation was
// structurally invisible to the suite: the description advertised a `subagent_type` route and a
// `momus` example while `Available agents:` read "none loaded". A caller that tried to honor the
// model-override note then had to invent an agent name. Rubato disables all four builtins
// (harness/rubato-pi/src/defaults.mjs), so this is its steady state, not an edge case.

const config: RubatoConfig = { categories: { grok: { description: "Fast lane" } }, agents: {} }
const noAgents: Readonly<Record<string, AgentDefinition>> = {}

describe("buildTaskToolDescription with zero loaded agents", () => {
  test("#given no loaded agents #when built #then the subagent_type route is not advertised", () => {
    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    // then
    expect(description).not.toContain("subagent_type")
    expect(description).not.toContain("none loaded")
  })

  test("#given no loaded agents #when built #then no agent name is offered as an example", () => {
    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    // then
    expect(description).not.toContain("momus")
    expect(description).not.toContain("undefined")
  })

  test("#given no loaded agents #when built #then the target rule accepts model or category", () => {
    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    // then
    expect(description).toContain("MUST provide a model or category")
  })

  test("#given no loaded agents #when built #then model-only target stays reachable", () => {
    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    expect(description).toContain("model is the default target")
    expect(description).toContain('task(model="kiro/claude-opus-5", prompt="...")')
    expect(description).toContain("current session's /model catalog")
  })

  test("#given no loaded agents #when built #then the category route survives intact", () => {
    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents: noAgents })

    // then
    expect(description).toContain("category is an optional compatibility preset")
    expect(description).toContain("grok")
  })

  test("#given agents are loaded again #when built #then the subagent_type route returns", () => {
    // given
    const agents: Readonly<Record<string, AgentDefinition>> = {
      explore: { name: "explore", description: "Codebase search" },
    }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    // then: the omission is conditional on the empty record, not a permanent removal.
    expect(description).toContain("subagent_type invokes a loaded agent directly")
    expect(description).toContain("explore")
    expect(description).toContain("model, category, or subagent_type")
  })
})
