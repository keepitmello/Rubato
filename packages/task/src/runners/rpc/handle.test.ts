import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, test } from "bun:test"

import type { RunnerOutcome } from "../in-process/child-handle"
import type { RpcChildHandle } from "../types"
import { createRpcChildHandle } from "./handle"
import type { RpcProtocolClient } from "./protocol-client"

type RpcHandleWithTerminalFacts = RpcChildHandle & {
  terminalAssistantMessage():
    | { readonly text?: string; readonly stopReason?: string; readonly errorMessage?: string }
    | undefined
  wasAbortedByUser(): boolean
  waitForOutcome(): Promise<RunnerOutcome>
}

function createHarness(): {
  readonly handle: RpcHandleWithTerminalFacts
  readonly emit: (event: AgentSessionEvent) => void
} {
  const child = Object.assign(new EventEmitter(), { pid: 4242 }) as unknown as ChildProcess
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const client = {
    stderrTail: "",
    send: () => Promise.resolve({ success: true }),
    onEvent: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    detach: () => listeners.clear(),
  } as unknown as RpcProtocolClient
  const handle = createRpcChildHandle({
    client,
    child,
    taskId: "st_00000001",
    heartbeatIntervalMs: 60_000,
    now: () => 1,
  }) as RpcHandleWithTerminalFacts
  return {
    handle,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
  }
}

function event(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent
}

describe("createRpcChildHandle terminal turn observation", () => {
  test("#given an assistant provider error followed by terminal agent_end #when idle settles #then text and failure fields are retained", async () => {
    // given
    const harness = createHarness()

    // when
    harness.emit(event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "401 unauthorized; re-authenticate",
      },
    }))
    harness.emit(event({ type: "agent_end", willRetry: false }))
    await harness.handle.waitForIdle()

    // then
    expect(harness.handle.terminalAssistantMessage()).toEqual({
      text: "partial",
      stopReason: "error",
      errorMessage: "401 unauthorized; re-authenticate",
    })
    expect(harness.handle.lastAssistantText()).toBe("partial")
    expect(harness.handle.wasAbortedByUser()).toBe(false)
    await harness.handle.dispose()
  })

  test("#given an explicit abort command #when the handle records it #then manager classification can distinguish user cancellation", async () => {
    // given
    const harness = createHarness()

    // when
    await harness.handle.abort()

    // then
    expect(harness.handle.wasAbortedByUser()).toBe(true)
    await harness.handle.dispose()
  })

  test("#given a completed resident turn #when a follow-up revives it #then terminal facts reset for the new turn while last text remains available", async () => {
    // given
    const harness = createHarness()
    harness.emit(event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" },
    }))
    harness.emit(event({ type: "agent_end", willRetry: false }))
    await harness.handle.waitForIdle()

    // when
    await harness.handle.followUp("second")

    // then
    expect(harness.handle.terminalAssistantMessage()).toBeUndefined()
    expect(harness.handle.lastAssistantText()).toBe("first")
    expect(harness.handle.wasAbortedByUser()).toBe(false)
    await harness.handle.dispose()
  })
})

describe("createRpcChildHandle turns the child starts on its own", () => {
  const turn = (harness: ReturnType<typeof createHarness>, text: string) => {
    harness.emit(event({ type: "agent_start" }))
    harness.emit(event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    }))
    harness.emit(event({ type: "agent_end", willRetry: false, messages: [] }))
  }

  test("#given a settled run #when the child wakes from its inbox and the turn is adopted #then the outcome is that turn's answer", async () => {
    // given
    const harness = createHarness()
    await harness.handle.followUp("start")
    expect(harness.handle.isRunActive?.()).toBe(true)
    turn(harness, "First pass done; waiting for the verifier.")
    expect(harness.handle.isRunActive?.()).toBe(false)

    // when
    harness.handle.adoptRun?.()
    expect(harness.handle.isRunActive?.()).toBe(true)
    const next = harness.handle.waitForOutcome()
    turn(harness, "Verifier's defect fixed and pushed.")

    // then
    await expect(next).resolves.toMatchObject({ status: "completed", finalResponse: "Verifier's defect fixed and pushed." })
    expect(harness.handle.isRunActive?.()).toBe(false)
    await harness.handle.dispose()
  })

  test("#given a handle reattached to a resting child #when nothing started a turn #then no run is tracked, so its next own turn can be adopted", async () => {
    const harness = createHarness()
    expect(harness.handle.isRunActive?.()).toBe(false)
    await harness.handle.dispose()
  })

  test("#given a tracked turn #when adoption is asked again #then the turn already tracked is kept", async () => {
    const harness = createHarness()
    await harness.handle.followUp("go")
    const tracked = harness.handle.waitForOutcome()
    harness.handle.adoptRun?.()
    turn(harness, "Done.")
    await expect(tracked).resolves.toMatchObject({ status: "completed", finalResponse: "Done." })
    await harness.handle.dispose()
  })
})
