import { describe, expect, test } from "bun:test"

import type { ManagerStartSpec, StartResult } from "../../manager"
import type { TaskRecord } from "../../state"
import { CTX, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"

describe("buildTaskExecute spawn", () => {
  test("#given an exact model #when executed #then it returns immediately WITHOUT awaiting child completion", async () => {
    let waitForCalls = 0
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => ({
        kind: "started",
        task_id: "st_00000001",
        status: "running",
        name: "bg-task",
      }),
      waitFor: () => {
        waitForCalls += 1
        return new Promise<TaskRecord>(() => {})
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))

    const result = await execute(
      "call-1",
      { prompt: "explore", model: "xai/grok-4.6" },
      undefined,
      undefined,
      CTX,
    )

    expect(waitForCalls).toBe(0)
    expect(result.details.agentId).toBe("st_00000001")
    expect(result.details.status).toBe("running")
    expect(result.content[0]?.type).toBe("text")
  })

  test("#given a background start #when the start result is rendered #then it directs the parent to yield instead of polling", async () => {
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => ({
        kind: "started",
        task_id: "st_00000015",
        status: "running",
        name: "background-research",
      }),
    })
    const execute = buildTaskExecute(makeDeps(manager))

    const result = await execute(
      "call-background-guidance",
      { prompt: "research", model: "xai/grok-4.6" },
      undefined,
      undefined,
      CTX,
    )

    const text = result.content[0]?.type === "text" ? result.content[0].text : ""
    const normalized = text.toLowerCase()
    expect(normalized).toContain("automatically delivered")
    expect(normalized).toContain("end your turn")
    expect(normalized).toContain("independent work")
    expect(normalized).not.toContain("read progress")
  })

  test("#given the caller session #when spawning #then callerSessionId is injected as parent_session_id", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_00000002", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))

    await execute("c", { prompt: "p", model: "xai/grok-4.6" }, undefined, undefined, CTX)

    expect(captured?.parent_session_id).toBe("parent-session-1")
    expect(captured?.root_session_id).toBe("parent-session-1")
    expect(captured?.depth).toBe(1)
    expect(captured?.model).toBe("xai/grok-4.6")
    expect(captured?.category).toBeUndefined()
    expect(captured?.subagent_type).toBeUndefined()
    expect(captured?.run_in_background).toBe(true)
  })

  test("#given a resolved background start #when executed #then resolved metadata reaches result details without prompt persistence", async () => {
    const resolvedModel = {
      provider: "openai",
      model_id: "gpt-5.6-sol",
      display: "GPT-5.6 Sol",
      reasoning_effort: "xhigh",
      source: "explicit" as const,
    }
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => ({
        kind: "started",
        task_id: "st_00000013",
        status: "running",
        name: "resolved-bg",
        resolved_model: resolvedModel,
      }),
      get: () => ({
        task_id: "st_00000013",
        status: "running" as const,
        name: "resolved-bg",
        resolved_model: resolvedModel,
        execution_mode: "in-process" as const,
      } as never),
    })
    const execute = buildTaskExecute(makeDeps(manager))

    const result = await execute(
      "call-resolved-bg",
      { prompt: "sensitive prompt", model: "openai/gpt-5.6-sol" },
      undefined,
      undefined,
      CTX,
    )

    expect(result.details.resolved_model).toEqual(resolvedModel)
    expect(Object.hasOwn(result.details, "prompt")).toBe(false)
  })

  test("#given config default execution mode #when spawning without an agent overlay #then config mode reaches the start spec", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_00000012", status: "running", name: "t" }
      },
    })
    const execute = buildTaskExecute(
      makeDeps(manager, {
        rubatoConfig: {
          categories: {},
          agents: {},
          task: {
            default_execution_mode: "process",
            default_concurrency: 5,
            global_concurrency: 8,
            max_depth: 1,
            residency_max_children: 8,
            ttl_ms: 86400000,
            resume_children: true,
            wait: { min_ms: 5000, default_ms: 60000, max_ms: 600000 },
            warnings: { unavailable_categories: true },
            team: { max_members: 8, max_parallel_members: 4, max_wall_clock_minutes: 120 },
          },
        },
      }),
    )

    await execute("c", { prompt: "p", model: "xai/grok-4.6" }, undefined, undefined, CTX)

    expect(captured?.execution_mode).toBe("process")
  })

  test("#given caller effort #when spawning #then it reaches the manager start spec as a manual override", async () => {
    let captured: ManagerStartSpec | undefined
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_reasoning", status: "running", name: "reasoning-task" }
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))

    await execute(
      "reasoning-call",
      { prompt: "p", model: "openai-codex/gpt-5.6-sol-fast", effort: "xhigh" },
      undefined,
      undefined,
      CTX,
    )

    expect(captured?.reasoning).toBe("xhigh")
  })

  test("#given omitted effort #when executed #then it does not wait on the child", async () => {
    let waitForCalls = 0
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => ({
        kind: "started",
        task_id: "st_00000004",
        status: "running",
        name: "async-task",
      }),
      waitFor: async () => {
        waitForCalls += 1
        throw new Error("waitFor must not run")
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))

    const result = await execute("c", { prompt: "p", model: "xai/grok-4.6" }, undefined, undefined, CTX)

    expect(waitForCalls).toBe(0)
    expect(result.details.status).toBe("running")
    expect(result.details.agentId).toBe("st_00000004")
  })
})
