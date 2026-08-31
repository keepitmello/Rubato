import { describe, expect, test } from "bun:test"

import type { ResolvedAgentSpec } from "@rubato/agent-core"

import type { ManagerStartSpec, StartResult, TaskManager } from "../../manager"
import { makeRecord } from "../output/__fixtures__/records"
import { createSenpiAgentHandle, createSenpiAgentHost, liveModelCatalog } from "./senpi-agent-host"

const SPEC: ResolvedAgentSpec = {
  prompt: "Inspect the host",
  model: "xai/grok-4.6",
  effort: "high",
  effortSource: "model-default",
}

function record(agentId: string, status: "running" | "cancelled" | "completed" = "running") {
  return makeRecord({
    task_id: agentId,
    name: "child",
    status,
    model: "xai/grok-4.6",
    parent_session_id: "parent-1",
    ...(status === "completed" ? { final_response: "done" } : {}),
  })
}

describe("createSenpiAgentHost", () => {
  test("#given a resolved spec #when spawned #then the handle uses agentId and send output cancel reach the manager", async () => {
    const starts: ManagerStartSpec[] = []
    const sends: Array<{ idOrName: string; message: string }> = []
    const cancels: string[] = []
    const records = new Map<string, ReturnType<typeof record>>()
    const manager: Pick<TaskManager, "start" | "sendToTask" | "cancelTask" | "get" | "subscribeChild"> = {
      start: async (spec) => {
        starts.push(spec)
        records.set("st_1", record("st_1"))
        return { kind: "started", task_id: "st_1", status: "running", name: "child" } satisfies StartResult
      },
      sendToTask: async (input) => {
        sends.push({ idOrName: input.idOrName, message: input.message })
        return { kind: "steered", task_id: input.idOrName, status: "running", delivered: "steer" }
      },
      cancelTask: async (idOrName) => {
        cancels.push(idOrName)
        records.set(idOrName, record(idOrName, "cancelled"))
        return { kind: "cancelled", task_id: idOrName, previous_status: "running" }
      },
      get: (id) => records.get(id),
      subscribeChild: () => () => {},
    }
    const host = createSenpiAgentHost({
      manager,
      models: { has: () => true },
      parentSessionId: () => "parent-1",
    })

    const handle = await host.spawn(SPEC)
    await handle.send("keep going")
    const snapshot = await handle.output()
    await handle.cancel()

    expect(handle.agentId).toBe("st_1")
    expect(starts).toEqual([
      {
        prompt: "Inspect the host",
        parent_session_id: "parent-1",
        root_session_id: "parent-1",
        depth: 1,
        run_in_background: true,
        execution_mode: "in-process",
        model: "xai/grok-4.6",
      },
    ])
    expect(sends).toEqual([{ idOrName: "st_1", message: "keep going" }])
    expect(snapshot).toEqual({
      agentId: "st_1",
      status: "running",
      model: "xai/grok-4.6",
    })
    expect(cancels).toEqual(["st_1"])
  })

  test("#given a completed child #when output is read #then the host snapshot includes the final output", async () => {
    const records = new Map<string, ReturnType<typeof record>>()
    records.set("st_done", record("st_done", "completed"))
    const handle = createSenpiAgentHandle(
      {
        get: (id) => records.get(id),
      },
      "st_done",
    )

    const snapshot = await handle.output()

    expect(snapshot).toEqual({
      agentId: "st_done",
      status: "completed",
      model: "xai/grok-4.6",
      output: "done",
    })
  })

  test("#given a caller from another session #when output is read #then the host refuses the snapshot", async () => {
    const records = new Map([["st_1", record("st_1")]])
    const handle = createSenpiAgentHandle(
      {
        get: (id) => records.get(id),
      },
      "st_1",
      { callerSessionId: "intruder" },
    )

    const error = await handle.output().then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    )

    expect(error?.message).toBe("No agent 'st_1'")
  })

  test("#given a missing model at spawn #when the manager reports model_unavailable #then the host fails before returning a handle", async () => {
    const host = createSenpiAgentHost({
      manager: {
        start: async () => ({
          kind: "plan_unresolved",
          error: { code: "model_unavailable", message: "model missing" },
        }),
        sendToTask: () => Promise.reject(new Error("unused")),
        cancelTask: () => Promise.reject(new Error("unused")),
        get: () => undefined,
        subscribeChild: () => () => {},
      },
      models: { has: () => false },
      parentSessionId: () => "parent-1",
    })

    const error = await host.spawn(SPEC).then(
      () => undefined,
      (thrown: unknown) => thrown as { code?: string; message: string },
    )

    expect(error?.code).toBe("model_unavailable")
    expect(error?.message).toBe("model missing")
  })
})

describe("liveModelCatalog", () => {
  test("#given no registry #when asked whether a model exists #then it fails closed", () => {
    const catalog = liveModelCatalog(() => undefined)
    expect(catalog.has("xai/grok-4.6")).toBe(false)
  })

  test("#given a live registry #when the exact provider/id is present #then it admits that model only", () => {
    const catalog = liveModelCatalog(() => ({
      getAvailable: () => [{ provider: "xai", id: "grok-4.6" }, { provider: "google-antigravity", id: "gemini-3.7-flash" }],
    }))

    expect(catalog.has("xai/grok-4.6")).toBe(true)
    expect(catalog.has("google-antigravity/gemini-3.7-flash")).toBe(true)
    expect(catalog.has("missing/model")).toBe(false)
    expect(catalog.has("grok-4.6")).toBe(false)
  })
})
