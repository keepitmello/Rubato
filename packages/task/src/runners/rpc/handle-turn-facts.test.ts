import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { describe, expect, test } from "bun:test"

import { CHILD_AWAITED_WAKES_REQUEST, createRpcChildHandle } from "./handle"
import type { RpcProtocolClient } from "./protocol-client"

function handleAnswering(answer: (command: { type: string; name?: string }) => unknown) {
  const child = Object.assign(new EventEmitter(), { pid: 4242 }) as unknown as ChildProcess
  const sent: Array<{ type: string; name?: string }> = []
  const client = {
    stderrTail: "",
    exited: false,
    send: (command: { type: string; name?: string }) => {
      sent.push(command)
      const response = answer(command)
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    },
    onEvent: () => () => {},
    detach: () => {},
  } as unknown as RpcProtocolClient
  const handle = createRpcChildHandle({ client, child, taskId: "st_00000001", heartbeatIntervalMs: 60_000, now: () => 1 })
  return { handle, sent }
}

describe("createRpcChildHandle turn facts", () => {
  test("#given a resting child with a bounded background command #when asked #then it answers idle, its last text and the wait", async () => {
    const { handle, sent } = handleAnswering((command) => {
      if (command.type === "get_state") return { type: "response", command: "get_state", success: true, data: { isStreaming: false } }
      if (command.type === "get_last_assistant_text") {
        return { type: "response", command: "get_last_assistant_text", success: true, data: { text: "Report two." } }
      }
      return {
        type: "response", command: "extension_request", success: true,
        data: { items: [{ id: "bash_3", description: "npm test" }, { id: "" }, { id: "mon_1" }] },
      }
    })

    await expect(handle.readTurnFacts()).resolves.toEqual({
      streaming: false,
      lastAssistantText: "Report two.",
      awaiting: [{ id: "bash_3", description: "npm test" }, { id: "mon_1", description: "mon_1" }],
    })
    expect(sent).toContainEqual({ type: "extension_request", name: CHILD_AWAITED_WAKES_REQUEST })
    await handle.dispose()
  })

  test("#given a child that cannot answer a question #when asked #then that fact is left out, not guessed", async () => {
    const { handle } = handleAnswering((command) =>
      command.type === "get_state"
        ? { type: "response", command: "get_state", success: true, data: { isStreaming: true } }
        : command.type === "extension_request"
          ? { type: "response", command: "extension_request", success: false, error: "Unknown command" }
          : new Error("closed"),
    )
    await expect(handle.readTurnFacts()).resolves.toEqual({ streaming: true })
    await handle.dispose()
  })
})
