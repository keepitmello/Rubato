import { describe, expect, test } from "bun:test"

import type { ResolvedAgentSpec } from "@rubato/agent-core"
import { CURSOR_GROK_BASE_ID, CURSOR_GROK_DEFAULT_FAST_ID, CURSOR_GROK_PRESENTED_ID, PRODUCT_MODEL_ORDER } from "@rubato/model-core"

import type { ManagerStartSpec, StartResult, TaskManager } from "../../manager"
import { makeRecord } from "../output/__fixtures__/records"
import { createSenpiAgentHandle, createSenpiAgentHost, liveModelCatalog, startSpecFromResolved, type SenpiAgentHostOptions } from "./senpi-agent-host"

const SPEC: ResolvedAgentSpec = {
  prompt: "Inspect the host",
  model: "xai/grok-4.7",
  effort: "high",
  effortSource: "model-default",
}

const CODEX_SOL = PRODUCT_MODEL_ORDER["openai-codex"][0]

function record(agentId: string, status: "running" | "cancelled" | "completed" = "running") {
  return makeRecord({
    task_id: agentId,
    name: "child",
    status,
    model: "xai/grok-4.7",
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
        model: "xai/grok-4.7",
      },
    ])
    expect(sends).toEqual([{ idOrName: "st_1", message: "keep going" }])
    expect(snapshot).toEqual({
      agentId: "st_1",
      status: "running",
      model: "xai/grok-4.7",
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
      model: "xai/grok-4.7",
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

describe("startSpecFromResolved service tier", () => {
  const options = {
    manager: {
      start: async () => {
        throw new Error("unused")
      },
      sendToTask: async () => {
        throw new Error("unused")
      },
      cancelTask: async () => {
        throw new Error("unused")
      },
      get: () => undefined,
      subscribeChild: () => () => {},
    },
    models: { has: () => true },
    parentSessionId: () => "parent-1",
  } satisfies SenpiAgentHostOptions

  test("#given fast is unset #when the start spec is built #then service_tier is absent", () => {
    const spec = startSpecFromResolved(SPEC, options)
    expect("service_tier" in spec).toBe(false)
  })

  test("#given fast is requested #when the start spec is built #then service_tier is priority", () => {
    const spec = startSpecFromResolved({ ...SPEC, fast: true }, options)
    expect(spec.service_tier).toBe("priority")
  })
})

describe("liveModelCatalog", () => {
  // 세대 id 는 카탈로그가 소유한다 — 여기서 손으로 적으면 세대가 바뀔 때마다 깨진다.
  const XAI_GROK = PRODUCT_MODEL_ORDER.xai[0]
  const ANTIGRAVITY_FLASH = PRODUCT_MODEL_ORDER["google-antigravity"][0]
  const ANTHROPIC_FABLE = PRODUCT_MODEL_ORDER.anthropic[0]

  test("#given no registry #when asked whether a model exists #then it fails closed", () => {
    const catalog = liveModelCatalog(() => undefined)
    expect(catalog.has(`xai/${XAI_GROK}`)).toBe(false)
    expect(catalog.list?.()).toEqual([])
  })

  test("#given a live registry #when the exact provider/id is present #then it admits that model only", () => {
    const catalog = liveModelCatalog(() => ({
      getAvailable: () => [{ provider: "xai", id: XAI_GROK }, { provider: "google-antigravity", id: ANTIGRAVITY_FLASH }],
    }))

    expect(catalog.has(`xai/${XAI_GROK}`)).toBe(true)
    expect(catalog.has(`google-antigravity/${ANTIGRAVITY_FLASH}`)).toBe(true)
    expect(catalog.has("missing/model")).toBe(false)
    expect(catalog.has(XAI_GROK)).toBe(false)
    expect(catalog.list?.()).toEqual([
      `xai/${XAI_GROK}`,
      `google-antigravity/${ANTIGRAVITY_FLASH}`,
    ])
  })

  test("#given live extras and a Fast-only cursor row #when listed #then only catalog identities remain", () => {
    const catalog = liveModelCatalog(() => ({
      getAvailable: () => [
        { provider: "xai", id: XAI_GROK },
        { provider: "cursor", id: `${CURSOR_GROK_BASE_ID}-high-fast` },
        { provider: "cursor", id: "secret-lab" },
      ],
    }))

    expect(catalog.has(CURSOR_GROK_PRESENTED_ID)).toBe(true)
    expect(catalog.has(CURSOR_GROK_DEFAULT_FAST_ID)).toBe(true)
    expect(catalog.has("cursor/secret-lab")).toBe(false)
    expect(catalog.list?.()).toEqual([`xai/${XAI_GROK}`, CURSOR_GROK_PRESENTED_ID])
  })

  test("#given live [sub] account rows #when listed for spawn #then the picker identities stay in the catalog", () => {
    const catalog = liveModelCatalog(() => ({
      getAvailable: () => [
        { provider: "anthropic", id: ANTHROPIC_FABLE },
        { provider: "anthropic", id: `${ANTHROPIC_FABLE}-sub` },
        { provider: "openai-codex", id: CODEX_SOL },
        { provider: "openai-codex", id: `${CODEX_SOL}-sub` },
      ],
    }))

    expect(catalog.has(`anthropic/${ANTHROPIC_FABLE}-sub`)).toBe(true)
    expect(catalog.has(`openai-codex/${CODEX_SOL}-sub`)).toBe(true)
    expect(catalog.list?.()).toEqual([
      `openai-codex/${CODEX_SOL}`,
      `openai-codex/${CODEX_SOL}-sub`,
      `anthropic/${ANTHROPIC_FABLE}`,
      `anthropic/${ANTHROPIC_FABLE}-sub`,
    ])
  })
})
