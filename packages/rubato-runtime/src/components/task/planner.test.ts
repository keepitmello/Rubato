import { describe, expect, test } from "bun:test"

import { BUILTIN_AGENTS, type SenpiModelPort } from "@rubato/task"

import { createTaskChildPlanner, type TaskModelRegistry } from "./planner"

function registry(models: readonly SenpiModelPort[]): TaskModelRegistry {
  return {
    getAvailable: () => [...models],
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
  }
}

describe("createTaskChildPlanner", () => {
  test("admits an exact live model", () => {
    const models = registry([{ provider: "openai-codex", id: "gpt-5.6-sol" }])
    const planner = createTaskChildPlanner(BUILTIN_AGENTS, () => models)

    const result = planner({ prompt: "work", parent_session_id: "parent", depth: 1, model: "openai-codex/gpt-5.6-sol" })

    expect(result).toMatchObject({ kind: "resolved", plan: { model: "openai-codex/gpt-5.6-sol" } })
  })

  test("refuses the OpenAI API provider even when it is live", () => {
    const models = registry([{ provider: "openai", id: "gpt-5.6-sol" }])
    const planner = createTaskChildPlanner(BUILTIN_AGENTS, () => models)

    const result = planner({ prompt: "work", parent_session_id: "parent", depth: 1, model: "openai/gpt-5.6-sol" })

    expect(result).toMatchObject({ kind: "error", error: { code: "model_unavailable" } })
  })

  test("fails closed for an unavailable exact model", () => {
    const planner = createTaskChildPlanner(BUILTIN_AGENTS, () => registry([]))

    const result = planner({ prompt: "work", parent_session_id: "parent", depth: 1, model: "missing/model" })

    expect(result).toMatchObject({ kind: "error", error: { code: "model_unavailable" } })
  })

  test("refuses a preset whose only live model is outside the product catalog", () => {
    const models = registry([{ provider: "cursor", id: "secret-lab" }, { provider: "xai", id: "grok-4.6" }])
    const planner = createTaskChildPlanner(
      { rogue: { name: "rogue", model: "cursor/secret-lab" } },
      () => models,
    )

    const rejected = planner({ prompt: "work", parent_session_id: "parent", depth: 1, preset: "rogue" })
    expect(rejected).toMatchObject({ kind: "error", error: { code: "model_unavailable" } })

    const admitted = planner({
      prompt: "work",
      parent_session_id: "parent",
      depth: 1,
      preset: "rogue",
      model: "xai/grok-4.6",
    })
    expect(admitted).toMatchObject({ kind: "resolved", plan: { model: "xai/grok-4.6" } })
  })

  test("requires only model or preset", () => {
    const planner = createTaskChildPlanner(BUILTIN_AGENTS, () => registry([]))

    const result = planner({ prompt: "work", parent_session_id: "parent", depth: 1 })

    expect(result).toEqual({ kind: "error", error: { code: "invalid_target", message: "A task requires a model or preset." } })
  })
})
