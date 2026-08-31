import { describe, expect, test } from "bun:test"
import type { ActionRequestEnvelope } from "@rubato/remote-protocol"
import { SessionActionQueue, type SurfaceActions } from "../src/action-queue.js"
import { deferred, HOST_ID, SESSION_ID } from "./helpers.js"

function request(requestId: string, text: string, expectedRevision = 4): ActionRequestEnvelope {
  return {
    protocol: "rubato.remote.v1",
    requestId,
    hostId: HOST_ID,
    liveSessionId: SESSION_ID,
    action: "input.submit",
    expectedRevision,
    payload: { text },
  }
}

describe("per-session action queue", () => {
  test("serializes dispatch and returns the cached result for duplicate request IDs", async () => {
    const firstDone = deferred<void>()
    const started: string[] = []
    const surface: SurfaceActions = {
      dispatch: async (value) => {
        if (value.action !== "input.submit") throw new Error("unexpected action")
        started.push(value.payload.text)
        if (value.payload.text === "first") await firstDone.promise
        return { accepted: true, revision: 5, payload: {} }
      },
    }
    const queue = new SessionActionQueue(surface, () => 4)
    const first = queue.enqueue(request("11111111-1111-4111-8111-111111111111", "first"))
    const second = queue.enqueue(request("22222222-2222-4222-8222-222222222222", "second"))
    await Promise.resolve()
    expect(started).toEqual(["first"])
    firstDone.resolve()
    await Promise.all([first, second])
    expect(started).toEqual(["first", "second"])

    await queue.enqueue(request("11111111-1111-4111-8111-111111111111", "changed"))
    expect(started).toEqual(["first", "second"])
  })

  test("rejects stale revisions before sending to the surface", async () => {
    let calls = 0
    const queue = new SessionActionQueue({ dispatch: async () => { calls++; return { accepted: true, revision: 6, payload: {} } } }, () => 5)
    await expect(queue.enqueue(request("33333333-3333-4333-8333-333333333333", "stale", 4))).rejects.toMatchObject({ code: "stale_revision" })
    expect(calls).toBe(0)
  })
})
