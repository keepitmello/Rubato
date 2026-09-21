import { afterEach, describe, expect, test } from "bun:test"

import type { SendInput, SendOutcome } from "../../steering"
import { FakeRunner, baseSpec, cleanupProjects, flush, makeManager } from "../../manager/__fixtures__/manager-fakes"
import { createMemberScopedTaskSendTool, createTaskSendTool, runTaskSend } from "./send"
import type { SendManager } from "./types"

afterEach(cleanupProjects)

function spyManager(outcome: SendOutcome): { manager: SendManager; sendCalls: SendInput[] } {
  const sendCalls: SendInput[] = []
  const manager: SendManager = {
    sendToTask: (input) => {
      sendCalls.push(input)
      return Promise.resolve(outcome)
    },
    list: () => [],
  }
  return { manager, sendCalls }
}

describe("runTaskSend", () => {
  test("#given task_send tool factories #when tools are created #then both expose custom call and result renderers", () => {
    const { manager } = spyManager({ kind: "not_found", reason: "unused", suggestion: "unused" })

    const leadTool = createTaskSendTool({ manager })
    const memberTool = createMemberScopedTaskSendTool({
      manager,
    })

    expect(typeof leadTool.renderCall).toBe("function")
    expect(typeof leadTool.renderResult).toBe("function")
    expect(typeof memberTool.renderCall).toBe("function")
    expect(typeof memberTool.renderResult).toBe("function")
  })

  test("#given a running child #when a message is sent #then it is delivered as steer", async () => {
    const { manager } = makeManager({})
    const started = await manager.start(baseSpec({ parent_session_id: "p1" }))
    if (started.kind !== "started") throw new Error("expected started")

    const result = await runTaskSend(manager, { agentId: started.task_id, message: "keep going" }, "p1")

    expect(result.details.kind).toBe("steered")
    if (result.details.kind !== "steered") throw new Error("expected steered")
    expect(result.details.delivered).toBe("steer")
    expect(result.details.agentId).toBe(started.task_id)
  })

  test("#given a caller session id #when sending #then callerSessionId is injected into the steering call", async () => {
    const { manager, sendCalls } = spyManager({ kind: "steered", task_id: "st_00000001", status: "running", delivered: "steer" })

    await runTaskSend(manager, { agentId: "st_00000001", message: "hi" }, "session-42")

    expect(sendCalls[0]?.callerSessionId).toBe("session-42")
    expect(sendCalls[0]?.allScope).toBeUndefined()
  })

  test("#given the public AgentSend schema #when inspected #then team routing shutdown and all_scope are absent", () => {
    const { manager } = spyManager({ kind: "not_found", reason: "unused", suggestion: "unused" })
    const tool = createTaskSendTool({ manager })
    const keys = Object.keys(tool.parameters.properties)

    expect(keys).toEqual(["agentId", "message"])
    expect(tool.description).not.toContain("all_scope")
    expect(tool.description).not.toContain("shutdown")
    expect(tool.description).not.toContain("team_run_id")
    expect(tool.description).not.toContain("task_id")
  })

  test("#given plain-text send without a message #when sent #then it is rejected before routing", async () => {
    const { manager, sendCalls } = spyManager({ kind: "not_found", reason: "unused", suggestion: "unused" })

    const result = await runTaskSend(manager, { agentId: "alpha" }, "lead-session")

    expect(result.details).toEqual({ kind: "invalid_arguments", reason: "message is required" })
    expect(sendCalls).toEqual([])
  })

  test("#given a child owned by another session #when sent without all_scope #then scope is denied naming the owner", async () => {
    const { manager } = makeManager({})
    const started = await manager.start(baseSpec({ parent_session_id: "owner-session" }))
    if (started.kind !== "started") throw new Error("expected started")

    const result = await runTaskSend(manager, { agentId: started.task_id, message: "hi" }, "intruder-session")

    expect(result.details.kind).toBe("scope_denied")
    if (result.details.kind !== "scope_denied") throw new Error("expected scope_denied")
    expect(result.details.owning_session_id).toBe("owner-session")
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain("owner-session")
  })

  test("#given an unknown name #when sending #then not_found lists this session's task names", async () => {
    const { manager } = makeManager({})
    const started = await manager.start(baseSpec({ parent_session_id: "p1", name: "alpha" }))
    if (started.kind !== "started") throw new Error("expected started")

    const result = await runTaskSend(manager, { agentId: "ghost", message: "hi" }, "p1")

    expect(result.details.kind).toBe("not_found")
    if (result.details.kind !== "not_found") throw new Error("expected not_found")
    expect(result.details.known_agents).toContain("alpha")
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain("alpha")
  })

  test("#given a string recipient that is not a child and no team routing #when sent #then the child not_found result is preserved", async () => {
    const { manager } = spyManager({ kind: "not_found", reason: "No task found for \"ghost\".", suggestion: "unused" })

    const result = await runTaskSend(manager, { agentId: "ghost", message: "hi" }, "p1")

    expect(result.details.kind).toBe("not_found")
  })

  test("#given a cancelled child #when task_send targets it #then it is not continuable", async () => {
    const { manager } = makeManager({})
    const started = await manager.start(baseSpec({ parent_session_id: "p1" }))
    if (started.kind !== "started") throw new Error("expected started")
    await manager.cancelTask(started.task_id, "done")

    const result = await runTaskSend(manager, { agentId: started.task_id, message: "revive?" }, "p1")

    expect(result.details.kind).toBe("not_continuable")
  })
})
