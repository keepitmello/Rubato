import { describe, expect, test } from "bun:test"

import { RubatoMemorySettingsLayerSchema, RubatoMemorySettingsSchema } from "./memory"

describe("RubatoMemorySettingsSchema per-agent overrides", () => {
  test("#given per-agent overrides #when parsed #then they stay default-free deep-partials", () => {
    // given
    const input = {
      agents: {
        "backend-lead": { enabled: false, reflection: { trigger: { step_count: 10 } } },
      },
    }

    // when
    const parsed = RubatoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.agents["backend-lead"]).toEqual({
      enabled: false,
      reflection: { trigger: { step_count: 10 } },
    })
  })

  test("#given an unknown key inside an agent override #when parsed #then validation fails", () => {
    // given
    const input = { agents: { "backend-lead": { bogus: true } } }

    // when
    const result = RubatoMemorySettingsSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given per-agent dream override #when parsed #then it overrides the base dream block", () => {
    // given
    const input = {
      agents: {
        "research-agent": { dream: { idle_minutes: 60 } },
      },
    }

    // when
    const parsed = RubatoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.agents["research-agent"]?.dream).toEqual({ idle_minutes: 60 })
  })

  test("#given per-agent nudge override #when parsed #then it overrides the base nudge block", () => {
    // given
    const input = {
      agents: {
        "research-agent": { nudge: { every_user_turns: 20 } },
      },
    }

    // when
    const parsed = RubatoMemorySettingsSchema.parse(input)

    // then
    expect(parsed.agents["research-agent"]?.nudge).toEqual({ every_user_turns: 20 })
  })
})

describe("RubatoMemorySettingsLayerSchema", () => {
  test("#given a partial layer block #when parsed #then it remains a default-free deep-partial", () => {
    // given
    const input = { reflection: { category: "deep" } }

    // when
    const parsed = RubatoMemorySettingsLayerSchema.parse(input)

    // then
    expect(parsed).toEqual({ reflection: { category: "deep" } })
  })

  test("#given an unknown layer key #when parsed #then the strict layer schema rejects it", () => {
    // given
    const input = { bogus: 1 }

    // when
    const result = RubatoMemorySettingsLayerSchema.safeParse(input)

    // then
    expect(result.success).toBe(false)
  })

  test("#given v2 block layer keys #when parsed #then they are accepted as deep-partials", () => {
    // given
    const input = {
      nudge: { every_user_turns: 5 },
      facts: { debounce_settles: 2 },
      dream: { idle_minutes: 0 },
      people: { max_entries: 20 },
      soul: { edit_notice: false },
    }

    // when
    const parsed = RubatoMemorySettingsLayerSchema.parse(input)

    // then
    expect(parsed).toEqual(input)
  })
})
