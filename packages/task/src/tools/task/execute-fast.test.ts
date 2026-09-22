import { describe, expect, test } from "bun:test"

import type { ManagerStartSpec, StartResult } from "../../manager"
import { CTX, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"

describe("buildTaskExecute fast", () => {
  test("#given fast is requested #when the tool spawns #then the start spec carries service_tier priority", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_fast", status: "running", name: "spawned" }
      },
    })

    await buildTaskExecute(makeDeps(manager))(
      "call",
      { prompt: "ship it", model: "xai/grok-4.7", fast: true },
      undefined,
      undefined,
      CTX,
    )

    expect(captured?.service_tier).toBe("priority")
  })

  test("#given fast is omitted #when the tool spawns #then the start spec has no service_tier field", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_plain", status: "running", name: "spawned" }
      },
    })

    await buildTaskExecute(makeDeps(manager))(
      "call",
      { prompt: "ship it", model: "xai/grok-4.7" },
      undefined,
      undefined,
      CTX,
    )

    expect(captured).toBeDefined()
    expect("service_tier" in (captured ?? {})).toBe(false)
    expect("memberEnv" in (captured ?? {})).toBe(false)
  })

  test("#given fast is false #when the tool spawns #then it is not a priority request", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_slow", status: "running", name: "spawned" }
      },
    })

    await buildTaskExecute(makeDeps(manager))(
      "call",
      { prompt: "ship it", model: "xai/grok-4.7", fast: false },
      undefined,
      undefined,
      CTX,
    )

    expect("service_tier" in (captured ?? {})).toBe(false)
  })
})
