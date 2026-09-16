import { describe, expect, test } from "bun:test"

import type { AgentDefinition } from "../../agents"
import { listTaskAgents } from "./categories"

describe("listTaskAgents", () => {
  test("#given loaded agent definitions #when listed #then names and descriptions surface, disabled excluded", () => {
    // given
    const agents: Readonly<Record<string, AgentDefinition>> = {
      momus: { name: "momus", description: "Deep reasoning" },
      hidden: { name: "hidden", description: "n/a", disable: true },
    }

    // when
    const listed = listTaskAgents(agents)

    // then
    expect(listed).toContainEqual({ name: "momus", description: "Deep reasoning" })
    expect(listed.map((entry) => entry.name)).not.toContain("hidden")
  })
})
