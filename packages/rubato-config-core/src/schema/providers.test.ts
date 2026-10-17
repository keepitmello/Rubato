import { describe, expect, test } from "bun:test"

import { RubatoConfigLayerSchema, RubatoConfigSchema } from "./config"

describe("providers", () => {
  test("a disabled list parses in the config and in a layer", () => {
    const providers = { disabled: ["cursor", "kiro"] }
    expect(RubatoConfigSchema.parse({ providers }).providers).toEqual(providers)
    expect(RubatoConfigLayerSchema.parse({ providers }).providers).toEqual(providers)
  })

  test("unknown keys under providers still fail", () => {
    expect(() => RubatoConfigSchema.parse({ providers: { off: ["cursor"] } })).toThrow()
  })
})
