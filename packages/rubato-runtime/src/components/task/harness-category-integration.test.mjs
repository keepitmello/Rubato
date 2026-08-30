import { describe, expect, test } from "bun:test"

import { loadRubatoPiRubatoConfig } from "../../../../../harness/rubato-pi/src/rubato-config.mjs"

import { createTaskChildPlanner } from "./planner"

function registry(models) {
  return {
    getAvailable: () => models,
    find: (provider, modelId) =>
      models.find((candidate) => candidate.provider === provider && candidate.id === modelId),
  }
}

function plan(category, models) {
  const planner = createTaskChildPlanner(
    loadRubatoPiRubatoConfig().config,
    {},
    () => registry(models),
  )
  return planner({
    prompt: "Verify harness category routing.",
    parent_session_id: "parent-1",
    depth: 0,
    category,
  })
}

describe("rubato-pi semantic category integration", () => {
  test("sol resolves Kiro first and carries the direct Codex route as fallback", () => {
    const result = plan("sol", [
      { provider: "kiro", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
    ])

    expect(result.kind).toBe("resolved")
    if (result.kind !== "resolved") return
    expect(result.plan.model).toBe("kiro/gpt-5.6-sol")
    expect(result.plan.fallback_models?.map((entry) => entry.display)).toEqual([
      "openai-codex/gpt-5.6-sol",
    ])
  })

  test("grok keeps Cursor and xAI as separate quota routes", () => {
    const result = plan("grok", [
      { provider: "cursor", id: "cursor-grok-4.6" },
      { provider: "xai", id: "grok-4.6" },
    ])

    expect(result.kind).toBe("resolved")
    if (result.kind !== "resolved") return
    expect(result.plan.model).toBe("cursor/cursor-grok-4.6")
    expect(result.plan.fallback_models ?? []).toEqual([])
  })
})
