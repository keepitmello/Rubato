import { describe, expect, test } from "bun:test"

import { createRestoredChildHandle, type ChildSession } from "./child-handle"

function fakeSession(order: string[], emit: () => Promise<unknown>): ChildSession {
  return {
    sessionId: "child-session",
    extensionRunner: {
      hasHandlers: (event) => event === "session_shutdown",
      emit: async (event) => {
        order.push(event.type)
        return emit()
      },
    },
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    getLastAssistantText: () => "done",
    dispose: () => {
      order.push("dispose")
    },
  }
}

describe("in-process child dispose", () => {
  test("announces session_shutdown to the child's extensions before disposing it", async () => {
    // Extensions release per-session registrations on session_shutdown. Without it, a child resumed
    // under the same session id met the previous child's registration and its invalidated ctx.
    const order: string[] = []
    const handle = createRestoredChildHandle({ taskId: "st_1", session: fakeSession(order, async () => undefined) })
    await handle.dispose()
    await handle.dispose()
    expect(order).toEqual(["session_shutdown", "dispose"])
  })

  test("still disposes the session when a shutdown handler fails", async () => {
    const order: string[] = []
    const handle = createRestoredChildHandle({
      taskId: "st_1",
      session: fakeSession(order, async () => {
        throw new Error("handler failed")
      }),
    })
    await handle.dispose()
    expect(order).toEqual(["session_shutdown", "dispose"])
  })
})
