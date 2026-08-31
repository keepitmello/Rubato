import { afterEach, describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import { cleanupProjects, makeManager } from "../../manager/__fixtures__/manager-fakes"
import type { TaskManager } from "../../manager"
import { buildTaskExecute } from "./execute"
import type { TaskToolContext, TaskToolDeps } from "./types"

const RUBATO_CONFIG: RubatoConfig = { categories: {}, agents: {} }

function ctxFor(sessionId: string): TaskToolContext {
  return { cwd: "/work/project", sessionManager: { getSessionId: () => sessionId } }
}

function deps(manager: TaskManager): TaskToolDeps {
  return { manager, rubatoConfig: RUBATO_CONFIG, agents: {}, models: { has: (model) => model.includes("/") } }
}

afterEach(() => {
  cleanupProjects()
})

describe("task tool spawn-only manager seam", () => {
  test("#given a real manager #when the task tool executes in two sessions #then both calls spawn children", async () => {
    const { manager, inProcess } = makeManager()
    const execute = buildTaskExecute(deps(manager))

    const first = await execute(
      "spawn-A",
      { prompt: "own work", model: "xai/grok-4.6" },
      undefined,
      undefined,
      ctxFor("session-A"),
    )
    const second = await execute(
      "spawn-B",
      { prompt: "more work", model: "xai/grok-4.6" },
      undefined,
      undefined,
      ctxFor("session-B"),
    )

    expect(first.details.mode).toBe("spawn")
    expect(second.details.mode).toBe("spawn")
    expect(first.details.agentId).not.toBe(second.details.agentId)
    expect(inProcess.handles.get(first.details.agentId)?.followUpCalls ?? []).toEqual([])
    expect(inProcess.handles.get(second.details.agentId)?.followUpCalls ?? []).toEqual([])
  })
})
