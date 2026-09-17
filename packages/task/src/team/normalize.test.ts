import { describe, expect, test } from "bun:test"

import { SenpiTeamSpecError } from "./errors"
import { normalizeSenpiTeamSpec, TEAM_LEAD_SENTINEL } from "./normalize"

const MODEL = "rubato-mock/mock-1"

describe("normalizeSenpiTeamSpec", () => {
  test("preserves owner and verifier kinds and reserves the current session as lead", () => {
    const spec = normalizeSenpiTeamSpec({
      members: [
        { kind: "owner", model: MODEL, prompt: "implement" },
        { kind: "verifier", model: MODEL, prompt: "review" },
      ],
    }, "research-team")

    expect(spec.name).toBe("research-team")
    expect(spec.members).toHaveLength(2)
    expect(spec.members.map((member) => member.kind)).toEqual(["owner", "verifier"])
    expect(spec.members.every((member) => member.model === MODEL)).toBe(true)
  })

  test("rejects members without an explicit taskforce kind", () => {
    expect(() => normalizeSenpiTeamSpec({ members: [{ model: MODEL, prompt: "work" }] }, "invalid-team")).toThrow("kind")
  })

  test("preserves an explicit team name", () => {
    const spec = normalizeSenpiTeamSpec({
      name: "explicit-name",
      members: [{ kind: "owner", model: MODEL, prompt: "work" }],
    }, "record-key")
    expect(spec.name).toBe("explicit-name")
  })

  test("parses a JSON-stringified spec", () => {
    const spec = normalizeSenpiTeamSpec(JSON.stringify({
      members: [{ kind: "owner", model: MODEL, prompt: "work" }],
    }), "json-team")
    expect(spec.members[0]).toMatchObject({ kind: "owner", model: MODEL })
  })

  test("wraps a single model member object from stored JSON", () => {
    const spec = normalizeSenpiTeamSpec({
      members: { kind: "owner", model: MODEL, prompt: "work" },
    }, "single-team")
    expect(spec.members).toHaveLength(1)
  })

  test("preserves model effort and task summary", () => {
    const spec = normalizeSenpiTeamSpec({
      members: [{ kind: "owner", model: MODEL, effort: "xhigh", prompt: "work", task_summary: "Investigate auth" }],
    }, "metadata-team")
    expect(spec.members[0]).toMatchObject({ kind: "owner", model: MODEL, effort: "xhigh", task_summary: "Investigate auth" })
  })

  test("clamps an over-limit task summary", () => {
    const spec = normalizeSenpiTeamSpec({
      members: [{ kind: "owner", model: MODEL, prompt: "work", task_summary: "x".repeat(120) }],
    }, "summary-team")
    expect(spec.members[0]?.task_summary).toHaveLength(80)
  })

  test("rejects raw lead declarations", () => {
    expect(() => normalizeSenpiTeamSpec({
      lead: { kind: "owner", model: MODEL, prompt: "lead" },
      members: [{ kind: "owner", model: MODEL, prompt: "work" }],
    }, "bad-lead")).toThrow(SenpiTeamSpecError)
  })

  test("rejects the reserved lead member name", () => {
    expect(() => normalizeSenpiTeamSpec({
      members: [{ name: TEAM_LEAD_SENTINEL, model: MODEL, prompt: "work" }],
    }, "bad-member")).toThrow(SenpiTeamSpecError)
  })

  test("rejects non-object specs with model-only guidance", () => {
    expect(() => normalizeSenpiTeamSpec([], "bad-spec")).toThrow("spec must be an object")
  })
})
