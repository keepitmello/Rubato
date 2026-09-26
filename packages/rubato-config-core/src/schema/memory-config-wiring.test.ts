import { describe, expect, test } from "bun:test"

import { resolveRubatoConfigView } from "../index"
import { RubatoConfigSchema } from "./config"

describe("memory config wiring", () => {
  test("#given a root memory block #when the config parses #then defaults materialize once", () => {
    // given
    const config = { memory: {} }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
    expect(result.data.memory?.enabled).toBe(true)
    expect(result.data.memory?.dream.stores).toEqual({})
  })

  test("#given memory blocks in harness and profile overlays #when parsed #then they stay default-free", () => {
    // given
    const config = {
      memory: { dream: { min_hours_between: 12 } },
      "[senpi]": { memory: { dream: { category: "deep" } } },
      profiles: { focused: { memory: { search: { enabled: false } } } },
    }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
    expect(result.data["[senpi]"]?.memory).toEqual({ dream: { category: "deep" } })
    expect(result.data.profiles.focused?.memory).toEqual({ search: { enabled: false } })
  })

  test("#given an unknown key inside a profile memory block #when parsed #then the config rejects it", () => {
    // given
    const config = { profiles: { focused: { memory: { bogus: 1 } } } }

    // when
    const result = RubatoConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(false)
  })
})

describe("memory profile and harness deep-merge", () => {
  test("#given base and senpi memory blocks #when folding the harness view #then memory deep-merges", () => {
    // given
    const config = {
      memory: { enabled: true, dream: { min_hours_between: 12, category: "deep" } },
      "[senpi]": { memory: { dream: { category: "quick" } } },
    }

    // when
    const result = resolveRubatoConfigView({ config, harness: "senpi" })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config["memory"]).toEqual({
      enabled: true,
      dream: { min_hours_between: 12, category: "quick" },
    })
  })

  test("#given base harness and profile memory blocks #when folding the profile view #then later layers win per leaf", () => {
    // given
    const config = {
      memory: { agent: "auto", dream: { min_hours_between: 15 } },
      "[senpi]": { memory: { dream: { category: "deep" } } },
      profiles: {
        focused: {
          memory: { dream: { min_hours_between: 30 } },
          "[senpi]": { memory: { search: { enabled: false } } },
        },
      },
    }

    // when
    const result = resolveRubatoConfigView({ config, harness: "senpi", profile: "focused" })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config["memory"]).toEqual({
      agent: "auto",
      dream: { min_hours_between: 30, category: "deep" },
      search: { enabled: false },
    })
  })
})
