import { describe, expect, test } from "bun:test"

import { normalizeTeamSpecInput } from "./team-spec-input-normalizer"

const MODEL = "rubato-mock/mock-1"

describe("normalizeTeamSpecInput", () => {
  test("preserves explicit member kinds and generates stable member names", () => {
    const normalized = normalizeTeamSpecInput({
      members: [
        { kind: "owner", model: MODEL, prompt: "inspect" },
        { kind: "owner", model: MODEL, prompt: "review" },
      ],
    }) as Record<string, any>

    expect(normalized.members).toMatchObject([
      { name: "mock-1-1", kind: "owner", model: MODEL },
      { name: "mock-1-2", kind: "owner", model: MODEL },
    ])
  })

  test("normalizes explicit team and member names", () => {
    const normalized = normalizeTeamSpecInput({
      name: "My Team",
      members: [{ name: "Agent 1: Reviewer", kind: "owner", model: MODEL, prompt: "review" }],
    }) as Record<string, any>

    expect(normalized.name).toBe("my-team")
    expect(normalized.members[0].name).toBe("agent-1-reviewer")
  })

  test("does not invent a prompt or rewrite unsupported member fields", () => {
    const normalized = normalizeTeamSpecInput({
      members: [{ kind: "owner", model: MODEL, role: "Reviewer", responsibilities: ["Check tests"] }],
    }) as Record<string, any>

    expect(normalized.members[0]).not.toHaveProperty("prompt")
    expect(normalized.members[0]).toMatchObject({ role: "Reviewer", responsibilities: ["Check tests"] })
  })

  test("keeps a single owner as a teammate without inventing another member", () => {
    const normalized = normalizeTeamSpecInput({
      members: [{ name: "owner", kind: "owner", model: MODEL, prompt: "work" }],
    }) as Record<string, any>
    expect(normalized.members).toHaveLength(1)
    expect(normalized.members[0]).toMatchObject({ name: "owner", kind: "owner" })
  })

  test("strips only empty optional fields", () => {
    const normalized = normalizeTeamSpecInput({
      members: [{ name: "worker", kind: "owner", model: MODEL, prompt: "work", cwd: "", color: "", capabilities: ["Code"] }],
    }) as Record<string, any>
    expect(normalized.members[0]).not.toHaveProperty("cwd")
    expect(normalized.members[0]).not.toHaveProperty("color")
    expect(normalized.members[0]).toHaveProperty("capabilities", ["Code"])
  })

  test("leaves non-object input unchanged", () => {
    expect(normalizeTeamSpecInput(null)).toBeNull()
    expect(normalizeTeamSpecInput("bad")).toBe("bad")
  })
})
