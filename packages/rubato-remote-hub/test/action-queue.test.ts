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
  test("out-of-band replies unblock a waiting action and concurrent duplicates share one dispatch", async () => {
    const done = deferred<void>()
    const started: string[] = []
    const queue = new SessionActionQueue({ dispatch: async value => {
      started.push(value.action)
      if (value.action === 'input.submit') await done.promise
      if (value.action === 'ui.respond') done.resolve()
      return { accepted: true, revision: 4, payload: {} }
    } }, () => 4)
    const first = queue.enqueue(request('waiting', 'first'))
    const reply: ActionRequestEnvelope = { protocol: 'rubato.remote.v1', hostId: HOST_ID, liveSessionId: SESSION_ID,
      requestId: 'answer', action: 'ui.respond', payload: { requestId: 'question', value: true } }
    const a = queue.enqueue(reply)
    const b = queue.enqueue(reply)
    expect(a).toBe(b)
    await Promise.all([first, a, b])
    expect(started).toEqual(['input.submit', 'ui.respond'])
  })

  test("revalidates a queued action when it actually reaches the surface and continues after rejection", async () => {
    const done = deferred<void>()
    let revision = 4
    let calls = 0
    const queue = new SessionActionQueue({ dispatch: async () => {
      calls++
      if (calls === 1) await done.promise
      return { accepted: true, revision, payload: {} }
    } }, () => revision)
    const first = queue.enqueue(request('first', 'first'))
    const stale = queue.enqueue(request('queued', 'queued'))
    await Promise.resolve()
    revision = 5
    const rejected = stale.catch(error => error)
    done.resolve()
    await first
    expect(await rejected).toMatchObject({ code: 'stale_revision' })
    await queue.enqueue(request('fresh', 'fresh', 5))
    expect(calls).toBe(2)
  })
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
