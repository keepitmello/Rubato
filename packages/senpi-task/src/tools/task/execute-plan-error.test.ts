import { describe, expect, test } from "bun:test"

import type { StartResult } from "../../manager"
import { CTX, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"

describe("buildTaskExecute plan errors", () => {
  test("#given an unknown preset #when executed #then it fails before spawn with preset_unavailable", async () => {
    let started = false
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => {
        started = true
        return { kind: "started", task_id: "st_x", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager, { agents: { explore: { name: "explore" } } }))

    const result = await execute("call-plan-error", { prompt: "p", preset: "nope" }, undefined, undefined, CTX)

    expect(started).toBe(false)
    expect(result.details.status).toBe("preset_unavailable")
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("preset 'nope' is not available")
  })

  test("#given a missing exact model #when executed #then it fails closed without calling start", async () => {
    let started = false
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => {
        started = true
        return {
          kind: "plan_unresolved",
          error: { code: "model_unavailable", message: "should not run" },
        }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager, { models: { has: () => false } }))

    const result = await execute("call-model-unavailable", { prompt: "p", model: "missing/model" }, undefined, undefined, CTX)

    expect(started).toBe(false)
    expect(result.details.status).toBe("model_unavailable")
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("missing/model")
  })
})
