import { describe, expect, test } from "bun:test"
import { RubatoConfigLayerSchema, RubatoConfigSchema } from "../index"

describe("rubato config schema", () => {
  test("#given a full rubato config still carrying a categories block #when parsed #then task defaults apply and the block drops", () => {
    // given
    const config = {
      $schema: "https://example.com/rubato.schema.json",
      categories: {
        deep: {
          description: "Deep analysis",
          model: "anthropic/claude",
          fallback_models: ["openai/gpt"],
          variant: "high",
          temperature: 0.2,
          top_p: 0.9,
          maxTokens: 12000,
          thinking: { type: "enabled", budgetTokens: 2048 },
          reasoningEffort: "high",
          textVerbosity: "medium",
          tools: { bash: true },
          prompt_append: "Think carefully.",
          max_prompt_tokens: 2000,
          is_unstable_agent: false,
          disable: false,
        },
      },
      agents: {
        reviewer: {
          description: "Reviews code",
          prompt: "Review this.",
          model: "openai/gpt-5",
          models: ["anthropic/claude"],
          tools: { bash: false, read: true },
          execution_mode: "in-process",
          background: true,
          max_depth: 1,
          allowed_subagents: ["quick"],
          temperature: 0.1,
          disable: false,
        },
      },
      codegraph: { daemon: true },
      task: {},
      teams: {
        builders: {
          description: "Build team",
          members: [
            { name: "quick-one", kind: "owner", model: "openai/gpt-5", prompt: "Help" },
            { name: "reviewer", kind: "verifier", model: "anthropic/claude", prompt: "Verify" },
          ],
        },
      },
    }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
    expect(result.data.codegraph?.daemon).toBe(true)
    expect(result.data.task?.default_execution_mode).toBe("in-process")
    expect(result.data.task?.default_concurrency).toBe(5)
    expect(result.data.task?.residency_max_children).toBe(8)
    expect("categories" in result.data).toBe(false)
  })

  test("#given categories in every layer, a dream category and task warnings #when parsed #then they drop and the rest stays strict", () => {
    // given: the shape configs carried while task categories existed
    const legacy = {
      categories: { grok: { models: ["xai/grok-4.7"] } },
      task: { warnings: { unavailable_categories: false }, max_depth: 2 },
      memory: { dream: { category: "grok", publish: "auto" } },
      "[senpi]": { categories: { deep: { model: "xai/grok-4.7" } }, task: { warnings: { unavailable_categories: true } } },
      "[codex]": { categories: {} },
      profiles: { work: { categories: { quick: {} }, "[senpi]": { categories: {} } } },
    }

    // when
    const full = RubatoConfigSchema.safeParse(legacy)
    const layer = RubatoConfigLayerSchema.safeParse(legacy)

    // then
    expect(full.success).toBe(true)
    expect(layer.success).toBe(true)
    if (!full.success || !layer.success) return
    expect(layer.data).toEqual({
      task: { max_depth: 2 },
      memory: { dream: { publish: "auto" } },
      "[senpi]": { task: {} },
      "[codex]": {},
      profiles: { work: { "[senpi]": {} } },
    })
    expect(full.data.memory?.dream.publish).toBe("auto")
    expect(RubatoConfigSchema.safeParse({ ...legacy, "[senpi]": { bogus: 1 } }).success).toBe(false)
  })

  test("#given an empty codegraph config #when parsed #then daemon defaults on", () => {
    // given
    const config = { codegraph: {} }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
    expect(result.data.codegraph?.daemon).toBe(true)
  })

  test("#given an unknown root key #when parsed #then the schema rejects the config", () => {
    // given
    const config = { unknown_section: true }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(false)
  })

  test("#given a wrong typed codegraph daemon setting #when parsed #then the issue path identifies the bad field", () => {
    // given
    const config = { codegraph: { daemon: "yes" } }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected config parsing to fail")
    const issuePaths = result.error.issues.map((issue) => issue.path.join("."))
    expect(issuePaths).toContain("codegraph.daemon")
  })

  test("#given a wrong typed task setting #when parsed #then the issue path identifies the bad field", () => {
    // given
    const config = { task: { default_concurrency: "five" } }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected config parsing to fail")
    const issuePaths = result.error.issues.map((issue) => issue.path.join("."))
    expect(issuePaths).toContain("task.default_concurrency")
  })
})
