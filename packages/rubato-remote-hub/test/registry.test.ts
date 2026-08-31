import { describe, expect, test } from "bun:test"
import { LiveRegistry, type ProcessDiscovery } from "../src/registry.js"
import { HOST_ID, SESSION_ID, summary } from "./helpers.js"

const process = {
  liveSessionId: SESSION_ID,
  zmxName: "rubato-018f1e2d3c4b",
  pid: 456,
  labels: { app: "rubato", rubato_live_id: SESSION_ID },
}

describe("live process registration and restart rebuild", () => {
  test("rebuilds zmx inventory as degraded, then replaces it from the surface snapshot", async () => {
    const discovery: ProcessDiscovery = { discover: async () => [process] }
    const registry = new LiveRegistry(HOST_ID, discovery)
    await registry.rebuild([summary({ title: "Persisted", pid: 123 })])

    expect(registry.get(SESSION_ID)).toMatchObject({ title: "Persisted", pid: 456, lifecycle: "degraded" })
    const registered = registry.register({
      surfaceInstanceId: "surface-a",
      token: "one-time-token",
      summary: summary({ title: "Live", pid: 456 }),
    }, "one-time-token")

    expect(registered.lifecycle).toBe("ready")
    expect(registry.get(SESSION_ID)?.title).toBe("Live")
    expect(registry.heartbeat(SESSION_ID, "surface-b")).toBeFalse()
    expect(registry.heartbeat(SESSION_ID, "surface-a", 1_000)).toBeTrue()
    expect(registry.markStale(31_001, 30_000)).toEqual([SESSION_ID])
  })

  test("ignores zmx names whose authoritative labels do not match", async () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [{ ...process, labels: { app: "other", rubato_live_id: SESSION_ID } }] })
    await registry.rebuild()
    expect(registry.list()).toEqual([])
  })
})
