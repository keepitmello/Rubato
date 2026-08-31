import { describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import type { AgentDefinition } from "../../agents"
import { buildTaskToolDescription } from "./description"

const CONFIG: RubatoConfig = { categories: {}, agents: {} }

function agentSet(): Readonly<Record<string, AgentDefinition>> {
  return {
    explore: { name: "explore", description: "Codebase search" },
    librarian: { name: "librarian", description: "Docs research" },
    metis: { name: "metis", description: "Pre-planning consultant" },
    momus: { name: "momus", description: "Plan reviewer" },
  }
}

describe("buildTaskToolDescription plan-gated agents", () => {
  test("#given gated and plain agents #when built #then plan-gated agents are classified separately with their invocation condition", () => {
    // given / when
    const description = buildTaskToolDescription({ rubatoConfig: CONFIG, agents: agentSet() })

    // then
    expect(description).toContain("Plan-gated presets")
    expect(description).toContain("ulw-plan")
    expect(description).toContain("start-work")
    expect(description).toContain("user explicitly request")
    expect(description).toContain(".rubato/plans")
    expect(description).toContain("metis")
    expect(description).toContain("momus")
  })

  test("#given gated and plain agents #when built #then the plain available-agents line excludes the gated names", () => {
    // given / when
    const description = buildTaskToolDescription({ rubatoConfig: CONFIG, agents: agentSet() })

    // then
    const availableNames = (description.split("\n").find((line) => line.includes("Available presets:")) ?? "")
      .split("Available presets:")[1]
      ?.split(". CORRECT")[0] ?? ""
    expect(availableNames).toContain("explore")
    expect(availableNames).toContain("librarian")
    expect(availableNames).not.toContain("metis")
    expect(availableNames).not.toContain("momus")
  })

  test("#given only plain agents #when built #then no plan-gated section is rendered", () => {
    // given
    const agents: Readonly<Record<string, AgentDefinition>> = {
      explore: { name: "explore", description: "Codebase search" },
    }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: CONFIG, agents })

    // then
    expect(description).not.toContain("Plan-gated presets")
  })
})
