import { describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import type { AgentDefinition } from "../../agents"
import { TASK_PROMPT_GUIDELINES, TASK_PROMPT_SNIPPET, buildTaskToolDescription } from "./description"

const agents: Readonly<Record<string, AgentDefinition>> = {
  explore: { name: "explore", description: "Codebase search" },
}

describe("buildTaskToolDescription", () => {
  test("#given the description #when built #then it states the model-or-preset contract", () => {
    const description = buildTaskToolDescription({ rubatoConfig: { categories: {}, agents: {} }, agents })

    expect(description).toContain(
      "Start one child agent using exactly one of `model` or `preset`. Omit `effort` normally; the configured model default applies. Set `effort` only when an explicit manual override is required.",
    )
    expect(description).toContain('Agent(model="cursor/cursor-grok-4.6", effort="xhigh", prompt="...")')
    expect(description).toContain('Agent(preset="explore", prompt="...")')
    expect(description).not.toContain("category")
    expect(description).not.toContain("subagent_type")
    expect(description).not.toContain("run_in_background")
    expect(description).not.toContain("load_skills")
  })

  test("#given the description #when built #then it describes async spawn and AgentSend continuation", () => {
    const description = buildTaskToolDescription({ rubatoConfig: { categories: {}, agents: {} }, agents })

    expect(description).toContain("AgentSend")
    expect(description).toContain("agentId")
    expect(description).not.toContain("task(task_id")
    expect(description).not.toContain("tasks")
  })

  test("#given loaded agents #when built #then it lists available presets", () => {
    const description = buildTaskToolDescription({ rubatoConfig: { categories: {}, agents: {} }, agents })

    expect(description).toContain("explore")
    expect(description).toContain("Available presets")
  })

  test("#given the guidelines #when read #then summary usage is advertised to the model", () => {
    expect(TASK_PROMPT_GUIDELINES.some((guideline) => guideline.includes("summary"))).toBe(true)
    expect(TASK_PROMPT_GUIDELINES.some((guideline) => guideline.includes("task_summary"))).toBe(false)
  })

  test("#given the prompt surfaces #when read #then snippet and guidelines are present", () => {
    expect(TASK_PROMPT_SNIPPET.length).toBeGreaterThan(0)
    expect(TASK_PROMPT_GUIDELINES.length).toBeGreaterThan(0)
  })
})
