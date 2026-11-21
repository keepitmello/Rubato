import { describe, expect, test } from "bun:test"

import { RubatoConfigLayerSchema, RubatoConfigSchema } from "./config"

describe("language", () => {
  test("a language parses in the config and in a layer", () => {
    expect(RubatoConfigSchema.parse({ language: "ko" }).language).toBe("ko")
    expect(RubatoConfigLayerSchema.parse({ language: "Korean" }).language).toBe("Korean")
  })

  test("an unset language stays unset", () => {
    expect(RubatoConfigSchema.parse({}).language).toBeUndefined()
  })

  test("an empty or non-string language fails", () => {
    expect(() => RubatoConfigSchema.parse({ language: "" })).toThrow()
    expect(() => RubatoConfigSchema.parse({ language: 3 })).toThrow()
  })
})
