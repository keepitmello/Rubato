import { describe, expect, test } from "bun:test"

import { RubatoConfigLayerSchema, RubatoConfigSchema } from "./config"

describe("titles", () => {
  test("a title ladder parses in the config and in a layer", () => {
    const titles = { models: ["opengateway/deepseek/deepseek-v4.1-flash-ultrafast", { model: "anthropic/claude-haiku-4-5", reasoning: "off" }] }
    expect(RubatoConfigSchema.parse({ titles }).titles).toEqual(titles)
    expect(RubatoConfigLayerSchema.parse({ titles }).titles).toEqual(titles)
  })

  test("an unset ladder stays unset so the built-in one applies", () => {
    expect(RubatoConfigSchema.parse({}).titles).toBeUndefined()
    expect(RubatoConfigSchema.parse({ titles: {} }).titles).toEqual({})
  })

  test("unknown keys under titles still fail", () => {
    expect(() => RubatoConfigSchema.parse({ titles: { model: "x/y" } })).toThrow()
  })
})
