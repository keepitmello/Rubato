import { describe, expect, test } from "bun:test"

import type { StartResult } from "../../manager"
import { CTX, createFakeManager, makeDeps, LIVE_MODEL } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"

const TASK_ID = "st_00000015"

function started(): Promise<StartResult> {
  return Promise.resolve({ kind: "started", task_id: TASK_ID, status: "running", name: "abortable-task" })
}

describe("buildTaskExecute abort handling", () => {
  test("#given a pre-aborted signal #when spawn executes #then it returns cancelled without starting a child", async () => {
    let startCalls = 0
    const manager = createFakeManager({
      start: () => {
        startCalls += 1
        return started()
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))
    const controller = new AbortController()
    controller.abort(new Error("parent already aborted"))

    const result = await execute(
      "call-pre-abort",
      { prompt: "work", model: LIVE_MODEL },
      controller.signal,
      undefined,
      CTX,
    )

    expect(startCalls).toBe(0)
    expect(result.details).toMatchObject({
      agentId: "",
      status: "cancelled",
      mode: "spawn",
      reason: "Parent aborted before spawn",
    })
  })

  test("#given a child has started #when the parent aborts afterwards #then the child survives without cancellation", async () => {
    let cancelCalls = 0
    const manager = createFakeManager({
      start: started,
      cancelTask: () => {
        cancelCalls += 1
        return Promise.resolve({ kind: "cancelled", task_id: TASK_ID, previous_status: "running" })
      },
    })
    const execute = buildTaskExecute(makeDeps(manager))
    const controller = new AbortController()
    const result = await execute(
      "call-background-abort",
      { prompt: "work", model: LIVE_MODEL },
      controller.signal,
      undefined,
      CTX,
    )

    controller.abort(new Error("parent aborted after background return"))
    await Promise.resolve()

    expect(result.details.status).toBe("running")
    expect(result.details.agentId).toBe(TASK_ID)
    expect(cancelCalls).toBe(0)
  })
})
