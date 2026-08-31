import { afterEach, describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import { cleanupProjects, makeManager } from "../../manager/__fixtures__/manager-fakes"
import type { TaskManager } from "../../manager"
import { buildTaskExecute } from "./execute"
import type { TaskToolContext, TaskToolDeps } from "./types"

const RUBATO_CONFIG: RubatoConfig = { categories: {}, agents: {} }

const CTX: TaskToolContext = {
  cwd: "/work/project",
  sessionManager: { getSessionId: () => "parent-session-1" },
}

function deps(manager: TaskManager): TaskToolDeps {
  return { manager, rubatoConfig: RUBATO_CONFIG, agents: {}, models: { has: (model) => model.includes("/") } }
}

afterEach(() => {
  cleanupProjects()
})

describe("task tool over the real TaskManager", () => {
  test("#given a background spawn #when driven end to end #then the engine start API persists a running record and returns its st_ id", async () => {
    // given the real manager + real store (no raw store writes from the tool layer)
    const { manager, store, inProcess } = makeManager()
    const execute = buildTaskExecute(deps(manager))

    // when
    const result = await execute(
      "call-1",
      { prompt: "explore", model: "xai/grok-4.6" },
      undefined,
      undefined,
      CTX,
    )

    // then the tool drove manager.start with the caller session, and the record landed in the store
    const taskId = result.details.agentId
    expect(taskId.startsWith("st_")).toBe(true)
    expect(inProcess.startedSpecs[0]?.parentSessionId).toBe("parent-session-1")
    expect(inProcess.startedSpecs[0]?.prompt).toBe("explore")
    const record = store.load(taskId)
    expect(record).not.toBeNull()
    if (record === null) throw new Error("expected a persisted record")
    expect(record.status).toBe("running")
    expect(record.model).toBe("xai/grok-4.6")
  })

  test("#given both model and preset #when driven #then the engine start API is never reached", async () => {
    const { manager, inProcess } = makeManager()
    const execute = buildTaskExecute({ ...deps(manager), agents: { momus: { name: "momus" } } })

    const result = await execute(
      "call-2",
      { prompt: "p", model: "xai/grok-4.6", preset: "momus" },
      undefined,
      undefined,
      CTX,
    )

    expect(result.details.status).toBe("invalid_request")
    expect(inProcess.startedSpecs).toHaveLength(0)
  })

  test("#given a missing exact model #when the catalog rejects it #then start is never reached", async () => {
    const { manager, inProcess } = makeManager()
    const execute = buildTaskExecute({ ...deps(manager), models: { has: () => false } })

    const result = await execute("call-3", { prompt: "p", model: "missing/model" }, undefined, undefined, CTX)

    expect(result.details.status).toBe("model_unavailable")
    expect(inProcess.startedSpecs).toHaveLength(0)
  })
})
