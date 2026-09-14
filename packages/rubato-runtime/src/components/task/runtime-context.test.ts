import { describe, expect, test } from "bun:test"

import { TaskRuntimeContext } from "./runtime-context"

describe("TaskRuntimeContext session facts", () => {
  test("captured UI and mode follow presentation rebinding without restarting the task runtime", () => {
    const runtime = new TaskRuntimeContext("/project")
    const makeUi = () => ({ notify() {}, setStatus() {}, setWidget() {}, async select() { return undefined }, async confirm() { return false } })
    const terminal = makeUi(), rpc = makeUi()
    let ui = terminal, mode = "tui"
    runtime.captureFrom({ get ui() { return ui }, get mode() { return mode } })
    expect(runtime.ui()).toBe(terminal)
    ui = rpc; mode = "rpc"
    expect(runtime.ui()).toBe(rpc)
    expect(runtime.mode()).toBe("rpc")
    runtime.clearUi()
    expect(runtime.ui()).toBeUndefined()
  })
  test("#given a live session manager with its file #when captured #then the exact file path is retained", () => {
    // given
    const runtime = new TaskRuntimeContext("/project")

    // when
    runtime.captureFrom({
      sessionManager: {
        getSessionId: () => "session-a",
        getSessionFile: () => "/tmp/senpi/sessions/session-a.jsonl",
      },
    })

    // then
    expect(runtime.sessionId()).toBe("session-a")
    expect(runtime.sessionFile()).toBe("/tmp/senpi/sessions/session-a.jsonl")
  })
})
