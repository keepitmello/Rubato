import { describe, expect, test } from "bun:test"

import { RubatoMemorySettingsLayerSchema, RubatoMemorySettingsSchema } from "./memory"

describe("RubatoMemorySettingsSchema", () => {
  test("#given an empty memory block #when parsed #then no store is named and the dream runs on the grok ladder under review", () => {
    // when
    const parsed = RubatoMemorySettingsSchema.parse({})

    // then
    expect(parsed.agent).toBe("auto")
    expect(parsed.dream.category).toBe("grok")
    expect(parsed.dream.publish).toBe("review")
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
    expect(full.data.dream).toEqual({ category: "grok", publish: "auto", stores: { rubato: { enabled: true } }, min_hours_between: 20 })
    expect(layer.data).toEqual({ agent: "rubato", dream: { publish: "auto", stores: { rubato: { enabled: true } } } })
  })

  test("#given a key no memory runtime ever read #when parsed #then strict parsing still rejects it", () => {
    expect(RubatoMemorySettingsSchema.safeParse({ bogus: 1 }).success).toBe(false)
    expect(RubatoMemorySettingsLayerSchema.safeParse({ dream: { bogus: 1 } }).success).toBe(false)
  })
})
