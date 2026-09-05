import { describe, expect, test } from "bun:test"
import { LiveRegistry, liveSessionTitle, type ProcessDiscovery } from "../src/registry.js"
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

  test("degraded summaries use the intended name or cwd basename rather than a generic default", async () => {
    const named = new LiveRegistry(HOST_ID, {
      discover: async () => [{ ...process, name: "Terminal", cwd: "/tmp/repo" }],
    })
    await named.rebuild()
    expect(named.get(SESSION_ID)).toMatchObject({ title: "Terminal", cwd: "/tmp/repo", lifecycle: "degraded" })

    const folder = new LiveRegistry(HOST_ID, {
      discover: async () => [{ ...process, cwd: "/Users/wy/Github-repos/agent-taskforce" }],
    })
    await folder.rebuild()
    expect(folder.get(SESSION_ID)?.title).toBe("agent-taskforce")

    const renamed = new LiveRegistry(HOST_ID, { discover: async () => [process] })
    await renamed.rebuild([summary({ title: "Rubato", cwd: "/tmp/repo" })])
    expect(renamed.get(SESSION_ID)?.title).toBe("Rubato")
  })

  test("cold degraded discovery falls back to zmxName when cwd and name are unavailable", async () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [process] })
    await registry.rebuild()
    expect(registry.get(SESSION_ID)).toMatchObject({
      title: process.zmxName,
      cwd: "",
      lifecycle: "degraded",
    })
  })

  test("register exposes the Pi session name terminal tabs use", async () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [process] })
    await registry.rebuild()
    const registered = registry.register({
      surfaceInstanceId: "surface-a",
      token: "one-time-token",
      summary: summary({ title: "Topic titles", cwd: "/tmp/repo" }),
    }, "one-time-token")
    expect(registered.title).toBe("Topic titles")

    const renamed = new LiveRegistry(HOST_ID, { discover: async () => [process] })
    await renamed.rebuild()
    expect(renamed.register({
      surfaceInstanceId: "surface-a",
      token: "one-time-token",
      summary: summary({ title: "Rubato", cwd: "/tmp/agent-taskforce" }),
    }, "one-time-token").title).toBe("Rubato")

    const unnamed = new LiveRegistry(HOST_ID, { discover: async () => [process] })
    await unnamed.rebuild()
    expect(unnamed.register({
      surfaceInstanceId: "surface-a",
      token: "one-time-token",
      summary: summary({ title: "", cwd: "/tmp/agent-taskforce" }),
    }, "one-time-token").title).toBe("agent-taskforce")
  })
})

describe("live session title parity with terminal tabs", () => {
  test("prefers any non-empty explicit name and otherwise uses the cwd basename", () => {
    expect(liveSessionTitle("Protocol work", "/tmp/repo")).toBe("Protocol work")
    expect(liveSessionTitle(undefined, "/Users/wy/Github-repos/agent-taskforce")).toBe("agent-taskforce")
    expect(liveSessionTitle("Rubato", "/tmp/repo")).toBe("Rubato")
    expect(liveSessionTitle("rubato", "/tmp/repo")).toBe("rubato")
    expect(liveSessionTitle("", "/tmp/repo")).toBe("repo")
    expect(liveSessionTitle(undefined, undefined, "rubato-018f1e2d3c4b")).toBe("rubato-018f1e2d3c4b")
  })
})

describe("live inventory pruning", () => {
  test("drops managed sessions whose zmx process disappeared", async () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [process] })
    await registry.rebuild()
    expect(registry.get(SESSION_ID)?.lifecycle).toBe("degraded")
    expect(registry.pruneMissingProcesses(new Set(), Date.now())).toEqual([SESSION_ID])
    expect(registry.get(SESSION_ID)).toBeUndefined()
  })

  test("keeps starting sessions briefly before the process is discoverable", async () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    registry.trackStarting(summary({ lifecycle: "starting", title: "repo", cwd: "/tmp/repo" }))
    expect(registry.pruneMissingProcesses(new Set(), Date.now(), 120_000)).toEqual([])
    expect(registry.pruneMissingProcesses(new Set(), Date.now() + 120_001, 120_000)).toEqual([SESSION_ID])
  })

  test("expires idle sessions after the configured quiet period", async () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    registry.trackStarting(summary({ lifecycle: "starting", execution: "idle", title: "repo", cwd: "/tmp/repo" }))
    const registered = registry.register({
      surfaceInstanceId: "surface-a",
      token: "one-time-token",
      summary: summary({ title: "Topic titles", execution: "idle" }),
    }, "one-time-token")
    expect(registered.title).toBe("Topic titles")
    expect(registry.idleExpired(Date.now(), 12 * 60 * 60 * 1000)).toEqual([])
    expect(registry.idleExpired(Date.now() + 12 * 60 * 60 * 1000, 12 * 60 * 60 * 1000)).toEqual([SESSION_ID])
    registry.noteExecution(SESSION_ID, "working", Date.now() + 12 * 60 * 60 * 1000)
    expect(registry.idleExpired(Date.now() + 24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000)).toEqual([])
    registry.noteExecution(SESSION_ID, "idle", Date.now() + 24 * 60 * 60 * 1000)
    expect(registry.idleExpired(Date.now() + 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000, 12 * 60 * 60 * 1000)).toEqual([SESSION_ID])
  })

  test("reaps interactive sessions with zero zmx clients after the detached TTL", async () => {
    const registry = new LiveRegistry(HOST_ID, {
      discover: async () => [{ ...process, clients: 0, pid: 456, labels: { app: "rubato", rubato_live_id: SESSION_ID } }],
    })
    await registry.rebuild()
    const now = Date.now()
    await registry.snapshotDiscovery(now)
    expect(registry.idleExpired(now + 29 * 60 * 1000, 12 * 60 * 60 * 1000, 30 * 60 * 1000)).toEqual([])
    expect(registry.idleExpired(now + 30 * 60 * 1000, 12 * 60 * 60 * 1000, 30 * 60 * 1000)).toEqual([SESSION_ID])
  })

  test("keeps persist-labeled sessions with zero clients until the idle TTL", async () => {
    const registry = new LiveRegistry(HOST_ID, {
      discover: async () => [{
        ...process,
        clients: 0,
        labels: { app: "rubato", rubato_live_id: SESSION_ID, rubato_persist: "1" },
      }],
    })
    await registry.rebuild()
    const now = Date.now()
    await registry.snapshotDiscovery(now)
    expect(registry.idleExpired(now + 30 * 60 * 1000, 12 * 60 * 60 * 1000, 30 * 60 * 1000)).toEqual([])
    expect(registry.idleExpired(now + 12 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 30 * 60 * 1000)).toEqual([SESSION_ID])
  })

  test("updateTitle follows the same terminal-tab naming rules", async () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [process] })
    await registry.rebuild()
    expect(registry.updateTitle(SESSION_ID, "Protocol work")).toBeTrue()
    expect(registry.get(SESSION_ID)?.title).toBe("Protocol work")
    expect(registry.updateTitle(SESSION_ID, "  ")).toBeFalse()
  })

  test("keeps a starting session whose zmx process is still running", () => {
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    registry.trackStarting(summary({ lifecycle: "starting", title: "repo", cwd: "/tmp/repo" }))
    const later = Date.now() + 120_001
    expect(registry.pruneStuckStarting(later, 120_000, new Set([SESSION_ID]))).toEqual([])
    expect(registry.get(SESSION_ID)?.lifecycle).toBe("starting")
    expect(registry.pruneStuckStarting(later, 120_000, new Set())).toEqual([SESSION_ID])
    expect(registry.get(SESSION_ID)).toBeUndefined()
  })
})
