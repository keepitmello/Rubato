import { describe, expect, test } from "bun:test"

import { TeamSpecSchema, parseMember } from "../types"
import { TeamSpecValidationError, validateDualSupport, validateSpec } from "./validator"

const MODEL = "rubato-mock/mock-1"

function member(name: string, prompt = "implement the assigned work", kind: "owner" | "verifier" = "owner") {
  return parseMember({ name, kind, model: MODEL, prompt })
}

describe("team spec validation", () => {
  test("accepts model-backed owner and verifier members", () => {
    const spec = TeamSpecSchema.parse({
      name: "team",
      members: [member("owner"), member("reviewer", "review the result", "verifier")],
    })
    expect(() => validateSpec(spec)).not.toThrow()
  })

  test("rejects duplicate member names", () => {
    const spec = TeamSpecSchema.parse({
      name: "team",
      members: [member("owner"), member("owner")],
    })
    expect(() => validateSpec(spec)).toThrow(TeamSpecValidationError)
  })

  test("rejects whitespace-only prompts", () => {
    const invalid = { ...member("owner"), prompt: "   " }
    expect(() => validateDualSupport(invalid)).toThrow("must not be empty")
  })

  test("parseMember preserves the taskforce member kind", () => {
    expect(parseMember({ name: "reviewer", kind: "verifier", model: MODEL, prompt: "work" })).toMatchObject({
      name: "reviewer",
      kind: "verifier",
      model: MODEL,
    })
    expect(parseMember({ name: "owner", kind: "owner", model: MODEL, prompt: "work" })).toMatchObject({
      kind: "owner",
      model: MODEL,
    })
  })

  test("parseMember rejects inputs without a kind or model", () => {
    expect(() => parseMember({ name: "owner", model: MODEL, prompt: "work" })).toThrow("must specify")
    expect(() => parseMember({ name: "owner", prompt: "work" })).toThrow("must specify")
  })
})
