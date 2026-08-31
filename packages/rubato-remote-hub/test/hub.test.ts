import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { basename, join } from "node:path"
import type { BootstrapLaunchPayload } from "@rubato/remote-protocol"
import { zmxNameForLiveSession } from "@rubato/remote-protocol"
import { SessionActionQueue } from "../src/action-queue.js"
import { EnvironmentHandoffStore, EnvironmentVault } from "../src/environment.js"
import { RemoteHub } from "../src/hub.js"
import { EventJournal } from "../src/journal.js"
import { AllowedPathResolver } from "../src/path-security.js"
import { LiveRegistry, type LaunchRequest } from "../src/registry.js"
import { SurfaceTokenStore } from "../src/surface-tokens.js"
import { HOST_ID, SESSION_ID, SESSION_2_ID, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("starting summary titles", () => {
  test("use the intended session name or cwd basename rather than a generic default", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const cwd = join(temporary.path, "agent-taskforce")
    await mkdir(cwd)
    const folderHub = await hubFor(temporary.path, SESSION_ID)
    const unnamed = await folderHub.create({ cwd, source: "terminal" })
    expect(unnamed.summary.title).toBe(basename(await realpath(cwd)))

    const namedHub = await hubFor(temporary.path, SESSION_2_ID)
    const named = await namedHub.create({ cwd, name: "Rubato", source: "terminal" })
    expect(named.summary.title).toBe("Rubato")
  })
})

async function hubFor(root: string, liveSessionId: typeof SESSION_ID | typeof SESSION_2_ID): Promise<RemoteHub> {
  const journal = new EventJournal(join(root, "journal"), join(root, "snapshots"), HOST_ID)
  await journal.load()
  const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
  return new RemoteHub({
    registry: new LiveRegistry(HOST_ID, { discover: async () => [] }),
    journal,
    actions: new SessionActionQueue({ dispatch: async () => ({ accepted: true, revision: 0, payload: {} }) }, () => 0),
    controller: {
      launch: async (request: LaunchRequest) => ({
        liveSessionId: request.liveSessionId,
        zmxName: zmxNameForLiveSession(request.liveSessionId),
        labels: request.labels,
      }),
      terminate: async () => {},
    },
    paths: new AllowedPathResolver([root]),
    vault: new EnvironmentVault(join(root, "launch-env.enc"), { getOrCreate: async () => Buffer.alloc(32) }),
    handoffs,
    surfaceTokens: new SurfaceTokenStore(),
    newLiveSessionId: () => liveSessionId,
    runtime: { socketPath: "/tmp/hub.sock", launcherPath: "/rubato", zmxBinary: "/zmx", buildId: "test" },
  })
}

describe("inventory maintenance", () => {
  test("terminates sessions that stayed idle past the TTL", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const terminated: string[] = []
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
    await journal.load()
    const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
    const registry = new LiveRegistry(HOST_ID, {
      discover: async () => [{
        liveSessionId: SESSION_ID,
        zmxName: zmxNameForLiveSession(SESSION_ID),
        labels: { app: "rubato", rubato_live_id: SESSION_ID },
      }],
    })
    const hub = new RemoteHub({
      registry,
      journal,
      actions: new SessionActionQueue({ dispatch: async () => ({ accepted: true, revision: 0, payload: {} }) }, () => 0),
      controller: {
        launch: async (request: LaunchRequest) => ({
          liveSessionId: request.liveSessionId,
          zmxName: zmxNameForLiveSession(request.liveSessionId),
          labels: request.labels,
        }),
        terminate: async (id) => { terminated.push(id) },
      },
      paths: new AllowedPathResolver([temporary.path]),
      vault: new EnvironmentVault(join(temporary.path, "launch-env.enc"), { getOrCreate: async () => Buffer.alloc(32) }),
      handoffs,
      surfaceTokens: new SurfaceTokenStore(),
      newLiveSessionId: () => SESSION_ID,
      runtime: { socketPath: "/tmp/hub.sock", launcherPath: "/rubato", zmxBinary: "/zmx", buildId: "test" },
    })
    const created = await hub.create({ cwd: temporary.path, source: "terminal", name: "Quiet" })
    registry.register({
      surfaceInstanceId: "surface-a",
      token: "token",
      summary: { ...created.summary, lifecycle: "ready", execution: "idle", title: "Quiet" },
    }, "token")
    const result = await hub.maintainInventory(Date.now() + 12 * 60 * 60 * 1000, { idleTtlMs: 12 * 60 * 60 * 1000, startingTimeoutMs: 1 })
    expect(result.idleExpired).toEqual([SESSION_ID])
    expect(terminated).toEqual([SESSION_ID])
    expect(registry.get(SESSION_ID)).toBeUndefined()
  })
})
