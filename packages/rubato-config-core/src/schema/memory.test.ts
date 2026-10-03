import { describe, expect, test } from "bun:test"

import { DEFAULT_DREAM_MODELS, RubatoMemorySettingsLayerSchema, RubatoMemorySettingsSchema } from "./memory"

describe("RubatoMemorySettingsSchema", () => {
  test("#given an empty memory block #when parsed #then no store is named and the dream runs on DeepSeek, then Grok, then Haiku under review", () => {
    // when
    const parsed = RubatoMemorySettingsSchema.parse({})

    // then
    expect(parsed.agent).toBe("auto")
    expect(parsed.dream.models).toEqual([
      { model: "b-ai/deepseek-v4.1-flash", reasoning: "medium" },
      { model: "xai/grok-4.7", reasoning: "medium" },
      { model: "anthropic/claude-haiku-4-5", reasoning: "off" },
    ])
    expect(parsed.dream.stores).toEqual({})
  })

  test("#given a config written for the old memory runtime #when parsed #then its retired keys drop and the kept ones survive", () => {
    // given: the shape ~/.rubato/rubato.jsonc and project configs carried before the cleanup
    const input = {
      agent: "rubato",
      reflection: { enabled: false, category: "grok", trigger: { step_count: 25 } },
      nudge: { enabled: true, every_user_turns: 10 },
      soul: { edit_notice: true },
      write_notice: { enabled: true },
      sync: { enabled: true },
      project: ["system/persona.md"],
      projection: { enabled: true },
      compile_warn_tokens: 30000,
      agents: { rubato: { nudge: { enabled: false } } },
      dream: {
        enabled: false,
        category: "grok",
        idle_minutes: 30,
        shutdown_launch: true,
        auto_select_max: 5,
        auto_select_max_chars: 150000,
        publish: "auto",
        stores: { rubato: { enabled: true } },
      },
    }

    // when
    const full = RubatoMemorySettingsSchema.safeParse(input)
    const layer = RubatoMemorySettingsLayerSchema.safeParse(input)

    // then
    expect(full.success).toBe(true)
    expect(layer.success).toBe(true)
    if (!full.success || !layer.success) return
    expect(Object.keys(full.data).sort()).toEqual(["agent", "dream", "enabled", "search", "tool_exposure"])
    expect(full.data.dream).toEqual({ models: [...DEFAULT_DREAM_MODELS], stores: { rubato: { enabled: true } }, min_hours_between: 20 })
    expect(layer.data).toEqual({ agent: "rubato", dream: { stores: { rubato: { enabled: true } } } })
  })

  test("#given dream models as bare ids and as model/reasoning pairs #when parsed #then both forms stay as written", () => {
    // given
    const models = ["xai/grok-4.7", { model: "anthropic/claude-haiku-4-5", reasoning: "off" as const }]

    // when
    const parsed = RubatoMemorySettingsSchema.parse({ dream: { models } })

    // then
    expect(parsed.dream.models).toEqual(models)
    expect(RubatoMemorySettingsSchema.safeParse({ dream: { models: [{ model: "xai/grok-4.7", reasoning: "turbo" }] } }).success).toBe(false)
    expect(RubatoMemorySettingsSchema.safeParse({ dream: { models: [{ model: "xai/grok-4.7", temperature: 1 }] } }).success).toBe(false)
  })

  test("#given a key no memory runtime ever read #when parsed #then strict parsing still rejects it", () => {
    expect(RubatoMemorySettingsSchema.safeParse({ bogus: 1 }).success).toBe(false)
    expect(RubatoMemorySettingsLayerSchema.safeParse({ dream: { bogus: 1 } }).success).toBe(false)
  })
})
