import { describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import type { AgentDefinition } from "../../agents"
import { TASK_PROMPT_GUIDELINES, TASK_PROMPT_SNIPPET, buildTaskToolDescription } from "./description"

const agents: Readonly<Record<string, AgentDefinition>> = {
  momus: { name: "momus", description: "Deep reasoning" },
}

describe("buildTaskToolDescription", () => {
  test("#given a custom rubato.json category #when the description is built #then it lists that category dynamically", () => {
    // given
    const config: RubatoConfig = {
      categories: { "release-crew": { description: "Ships the release train" } },
      agents: {},
    }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    // then
    expect(description).toContain("release-crew")
    expect(description).toContain("Ships the release train")
  })

  test("#given the description #when built #then it prefers semantic category and keeps model override", () => {
    // given
    const config: RubatoConfig = { categories: {}, agents: {} }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    // then
    expect(description).toContain("MUST provide a model, category, or subagent_type")
    expect(description).toContain('task(category="grok", prompt="...")')
    expect(description).toContain('task(model="kiro/claude-opus-5", prompt="...")')
    expect(description).toContain("model is an explicit override")
  })

  test("#given the description #when built #then it describes spawn-only task and task_send continuation", () => {
    // given
    const config: RubatoConfig = { categories: {}, agents: {} }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    // then
    expect(description).toContain("task_send")
    expect(description).not.toContain("task(task_id")
    expect(description).toContain("run_in_background")
  })

  test("#given loaded agents #when built #then it lists available agent types", () => {
    // given
    const config: RubatoConfig = { categories: {}, agents: {} }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    // then
    expect(description).toContain("momus")
  })

  test("#given the guidelines #when read #then task_summary usage is advertised to the model", () => {
    // given / when / then
    expect(TASK_PROMPT_GUIDELINES.some((guideline) => guideline.includes("task_summary"))).toBe(true)
  })

  test("#given the prompt surfaces #when read #then snippet and guidelines are present", () => {
    // then
    expect(TASK_PROMPT_SNIPPET.length).toBeGreaterThan(0)
    expect(TASK_PROMPT_GUIDELINES.length).toBeGreaterThan(0)
  })

  test("#given task prompt surfaces #when responsibilities are inspected #then target selection belongs to the tool description only", () => {
    // given
    const config: RubatoConfig = { categories: {}, agents: {} }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })
    const duplicatedTargetRule = TASK_PROMPT_GUIDELINES.some(
      (guideline) => /category.*subagent_type|subagent_type.*category/i.test(guideline),
    )

    // then
    expect(description).toMatch(/\bprompt\b/)
    expect(description).toMatch(/\btasks\b/)
    expect(duplicatedTargetRule).toBe(false)
  })

  test("#given caller-directed category guidance #when description is built #then selection sentinels reach the caller", () => {
    // given
    const config: RubatoConfig = { categories: {}, agents: {} }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    // then
    expect(description).toContain("<Selection_Gate>")
    expect(description).toContain("<Caller_Warning>")
  })
})

describe("buildTaskToolDescription category model overrides", () => {
  test("#given the description #when built #then it makes category the semantic default", () => {
    // given
    const config: RubatoConfig = { categories: {}, agents: {} }

    // when
    const description = buildTaskToolDescription({ rubatoConfig: config, agents })

    // then
    expect(description).toContain("category is the default semantic target")
    expect(description).toContain("model is an explicit override")
    expect(description).toContain("subagent_type invokes a loaded agent persona")
  })

  test("#given the prompt guidelines #when read #then they assign live routing to the harness", () => {
    const joined = TASK_PROMPT_GUIDELINES.join("\n")
    expect(joined).toContain("model")
    expect(joined).toContain("category")
    expect(joined).toContain("harness resolves its live provider")
  })
})
