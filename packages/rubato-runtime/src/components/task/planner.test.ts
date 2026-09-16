import { describe, expect, test } from "bun:test"

import { BUILTIN_AGENTS, type SenpiModelPort } from "@rubato/senpi-task"

import { createTaskChildPlanner, type TaskModelRegistry } from "./planner"

function registry(models: readonly SenpiModelPort[]): TaskModelRegistry {
  return {
    getAvailable: () => [...models],
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
  }
}

describe("createTaskChildPlanner", () => {
  test("admits an exact live model", () => {
    const models = registry([{ provider: "openai", id: "gpt-5.6-sol" }])
    const planner = createTaskChildPlanner({}, BUILTIN_AGENTS, () => models)

    const result = planner({ prompt: "work", parent_session_id: "parent", depth: 1, model: "openai/gpt-5.6-sol" })

    expect(result).toMatchObject({ kind: "resolved", plan: { model: "openai/gpt-5.6-sol" } })
  })

  test("fails closed for an unavailable exact model", () => {
    const planner = createTaskChildPlanner({}, BUILTIN_AGENTS, () => registry([]))

    const result = planner({ prompt: "work", parent_session_id: "parent", depth: 1, model: "missing/model" })

    expect(result).toMatchObject({ kind: "error", error: { code: "model_unavailable" } })
  })

  test("requires only model or preset", () => {
    const planner = createTaskChildPlanner({}, BUILTIN_AGENTS, () => registry([]))

    const result = planner({ prompt: "work", parent_session_id: "parent", depth: 1 })

    expect(result).toEqual({ kind: "error", error: { code: "invalid_target", message: "A task requires a model or preset." } })
  })
})
