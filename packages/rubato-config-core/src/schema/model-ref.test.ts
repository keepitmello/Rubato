import { describe, expect, test } from "bun:test"

import { RubatoModelRefObjectSchema, RubatoModelRefSchema, RubatoReasoningSchema } from "./model-ref"

describe("RubatoModelRefSchema", () => {
  test("#given canonical levels, auto, and a native preset #when parsed #then every reasoning token is accepted", () => {
    // given
    const values = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "thinking"]

    // when
    const results = values.map((reasoning) => RubatoReasoningSchema.safeParse(reasoning))

    // then
    expect(results.every((result) => result.success)).toBe(true)
  })

  test("#given string and object model references #when parsed #then both canonical forms survive", () => {
    // given
    const stringRef = "openai/gpt-5:high"
    const objectRef = {
      model: "openai/gpt-5",
      reasoning: "high",
      temperature: 0.4,
      top_p: 0.8,
      max_tokens: 4096,
      provider_options: { service_tier: "priority" },
    }

    // when
    const stringResult = RubatoModelRefSchema.parse(stringRef)
    const objectResult = RubatoModelRefSchema.parse(objectRef)

    // then
    expect(stringResult).toBe(stringRef)
    expect(objectResult).toEqual(objectRef)
  })

  test("#given out of range tuning and unknown keys #when parsed #then the strict object rejects them", () => {
    // given
    const values = [
      { model: "openai/gpt-5", temperature: 2.1 },
      { model: "openai/gpt-5", top_p: -0.1 },
      { model: "openai/gpt-5", max_tokens: 0 },
      { model: "openai/gpt-5", variant: "high" },
    ]

    // when
    const results = values.map((value) => RubatoModelRefObjectSchema.safeParse(value))

    // then
    expect(results.every((result) => !result.success)).toBe(true)
  })
})
