import { describe, expect, test } from "bun:test"

import type { ManagerStartSpec, StartResult } from "../../manager"
import { CTX, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"

describe("buildTaskExecute spawn validation", () => {
  test("#given prompt and model only #when executed #then manager receives an exact-model spec", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_model", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))

    const result = await execute("c", { prompt: "p", model: "kiro/claude-opus-5" }, undefined, undefined, CTX)

    expect(captured).toMatchObject({ prompt: "p", model: "kiro/claude-opus-5" })
    expect(captured?.category).toBeUndefined()
    expect(captured?.subagent_type).toBeUndefined()
    expect(result.details.status).toBe("running")
  })

  test("#given both model and preset #when executed #then it returns invalid_request without spawning", async () => {
    let started = false
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => {
        started = true
        return { kind: "started", task_id: "st_x", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager, { agents: { momus: { name: "momus" } } }))

    const result = await execute(
      "c",
      { prompt: "p", model: "xai/grok-4.6", preset: "momus" },
      undefined,
      undefined,
      CTX,
    )

    expect(started).toBe(false)
    expect(result.details.status).toBe("invalid_request")
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("Exactly one")
  })

  test("#given neither model nor preset #when executed #then it returns invalid_request without spawning", async () => {
    let started = false
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => {
        started = true
        return { kind: "started", task_id: "st_x", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))

    const result = await execute("c", { prompt: "p" }, undefined, undefined, CTX)

    expect(started).toBe(false)
    expect(result.details.status).toBe("invalid_request")
  })

  test("#given a missing exact model #when executed #then it fails closed with model_unavailable and does not start", async () => {
    let started = false
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => {
        started = true
        return { kind: "started", task_id: "st_x", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager, { models: { has: () => false } }))

    const result = await execute("c", { prompt: "p", model: "missing/model" }, undefined, undefined, CTX)

    expect(started).toBe(false)
    expect(result.details.status).toBe("model_unavailable")
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("missing/model")
  })

  test("#given an omitted model catalog #when executed #then exact models fail closed", async () => {
    let started = false
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => {
        started = true
        return { kind: "started", task_id: "st_x", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute({
      ...makeDeps(manager),
      models: { has: () => false },
    })

    const result = await execute("c", { prompt: "p", model: "xai/grok-4.6" }, undefined, undefined, CTX)

    expect(started).toBe(false)
    expect(result.details.status).toBe("model_unavailable")
  })

  test("#given a loaded preset #when executed #then manager receives the named-agent path", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_preset", status: "running", name: "momus" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager, { agents: { explore: { name: "explore", prompt: "Search." } } }))

    const result = await execute("c", { prompt: "review", preset: "explore" }, undefined, undefined, CTX)

    expect(captured?.subagent_type).toBe("explore")
    expect(captured?.model).toBeUndefined()
    expect(captured?.category).toBeUndefined()
    expect(result.details.status).toBe("running")
  })

  test("#given an injected ancestry #when spawning #then child depth and root derive from it", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_0000000f", status: "running", name: "t" }
      },
    })
    const deps = makeDeps(manager, { resolveAncestry: () => ({ depth: 2, rootSessionId: "root-session" }) })
    const execute = buildTaskExecute(deps)

    await execute("c", { prompt: "p", model: "xai/grok-4.6" }, undefined, undefined, CTX)

    expect(captured?.depth).toBe(3)
    expect(captured?.root_session_id).toBe("root-session")
  })
})
