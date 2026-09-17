import { describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import { mapRubatoConfigAgents } from "./rubato-config-agents"

function config(agents: NonNullable<RubatoConfig["agents"]>): RubatoConfig {
  return { agents }
}

describe("mapRubatoConfigAgents", () => {
  test("#given a rubato.json agent with the full field set #when mapped #then snake_case config keys land on the camelCase AgentDefinition with the record key as name", () => {
    // given
    const source = config({
      reviewer: {
        description: "Reviews diffs",
        prompt: "You are a reviewer.",
        model: "openai/gpt-5",
        models: ["openai/gpt-5", "anthropic/claude"],
        execution_mode: "process",
        background: true,
        max_depth: 2,
        allowed_subagents: ["quick"],
        temperature: 0.4,
        disable: false,
      },
    })

    // when
    const agents = mapRubatoConfigAgents(source)

    // then
    expect(agents.reviewer).toEqual({
      name: "reviewer",
      description: "Reviews diffs",
      prompt: "You are a reviewer.",
      model: "openai/gpt-5",
      models: ["openai/gpt-5", "anthropic/claude"],
      executionMode: "process",
      background: true,
      maxDepth: 2,
      allowedSubagents: ["quick"],
      temperature: 0.4,
      disable: false,
    })
  })

  test("#given the rubato.json tools record #when mapped #then each boolean entry becomes a pattern/allow rule", () => {
    // given
    const source = config({
      builder: {
        tools: { read: true, bash: false },
      },
    })

    // when
    const agents = mapRubatoConfigAgents(source)

    // then
    expect(agents.builder?.name).toBe("builder")
    expect(agents.builder?.tools).toEqual([
      { pattern: "read", allow: true },
      { pattern: "bash", allow: false },
    ])
  })

  test("#given an agent with only a name-worth of config #when mapped #then absent optional keys stay absent", () => {
    // given
    const source = config({ minimal: {} })

    // when
    const agents = mapRubatoConfigAgents(source)

    // then
    expect(agents.minimal).toEqual({ name: "minimal" })
  })

  test("#given a config with no agents #when mapped #then the result is an empty record", () => {
    // given / when
    const agents = mapRubatoConfigAgents({})

    // then
    expect(agents).toEqual({})
  })
})
