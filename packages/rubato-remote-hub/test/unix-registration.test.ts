import { afterEach, describe, expect, test } from "bun:test"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import { stat } from "node:fs/promises"
import { encodeFrame, JsonFrameDecoder, type BootstrapLaunchPayload } from "@rubato/remote-protocol"
import { EnvironmentHandoffStore } from "../src/environment.js"
import { EventJournal } from "../src/journal.js"
import { LiveRegistry } from "../src/registry.js"
import { SurfaceReconnectCredentials } from "../src/surface-credentials.js"
import { SurfaceTokenStore } from "../src/surface-tokens.js"
import { SurfaceSocketServer } from "../src/unix-server.js"
import { HOST_ID, SESSION_ID, summary, temporaryDirectory } from "./helpers.js"

const cleanupTasks: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup())))

describe("Unix socket process registration", () => {
  test("requires a one-time launch token and installs the surface snapshot", async () => {
    const temporary = await temporaryDirectory()
    cleanupTasks.push(temporary.cleanup)
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    const snapshotWritten = Promise.withResolvers<void>()
    const journal = new SignalingJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), snapshotWritten.resolve)
    await journal.load()
    const tokens = new SurfaceTokenStore()
    const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
    const socketPath = join(temporary.path, "socket", "hub.sock")
    const server = new SurfaceSocketServer(socketPath, registry, journal, tokens, handoffs, new SurfaceReconnectCredentials(join(temporary.path, "credential-key")))
    await server.listen()
    cleanupTasks.push(() => server.close())
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)

    const token = tokens.issue(SESSION_ID)
    const client = await connect(socketPath)
    const response = nextFrame(client)
    const registrationSummary = unmanagedSummary()
    client.write(encodeFrame({
      kind: "surface.register",
      protocol: "rubato.remote.v1",
      protocolRange: { min: 1, max: 1 },
      surfaceInstanceId: "00000000-0000-4000-8000-000000000001",
      token,
      summary: registrationSummary,
    }))
    expect(await response).toMatchObject({ kind: "hub.registered" })
    expect(registry.get(SESSION_ID)?.lifecycle).toBe("ready")
    const command = { name: "compact", description: "Compact conversation context", category: "builtin" as const, remoteMode: "native-action" as const }
    client.write(encodeFrame({
      kind: "surface.snapshot",
      protocol: "rubato.remote.v1",
      surfaceInstanceId: "00000000-0000-4000-8000-000000000001",
      sourceSeq: 1,
      at: "2026-08-31T00:00:00.000Z",
      summary: registrationSummary,
      state: { revision: 7, entries: [], tree: [], commands: [command], capabilities: [] },
    }))
    await bounded(snapshotWritten.promise)
    expect(journal.getSnapshot(SESSION_ID)?.state.commands).toEqual([command])
    client.destroy()

    const replay = await connect(socketPath)
    const closed = new Promise<void>((resolve) => replay.once("close", () => resolve()))
    replay.write(encodeFrame({ kind: "surface.register", protocol: "rubato.remote.v1", protocolRange: { min: 1, max: 1 }, surfaceInstanceId: "00000000-0000-4000-8000-000000000002", token, summary: registrationSummary }))
    await bounded(closed)
    expect(registry.heartbeat(SESSION_ID, "00000000-0000-4000-8000-000000000002")).toBeFalse()
  })

  test("hands encrypted launch environment to bootstrap exactly once", async () => {
    const temporary = await temporaryDirectory()
    cleanupTasks.push(temporary.cleanup)
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
    await journal.load()
    const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
    const server = new SurfaceSocketServer(join(temporary.path, "hub.sock"), registry, journal, new SurfaceTokenStore(), handoffs, new SurfaceReconnectCredentials(join(temporary.path, "credential-key")))
    await server.listen()
    cleanupTasks.push(() => server.close())
    const launch = launchPayload()
    const token = handoffs.issue(launch)

    const first = await connect(join(temporary.path, "hub.sock"))
    const response = nextFrame(first)
    first.write(encodeFrame({ kind: "bootstrap.claim", protocol: "rubato.remote.v1", token }))
    expect(await response).toEqual({ kind: "hub.launch", protocol: "rubato.remote.v1", launch })

    const second = await connect(join(temporary.path, "hub.sock"))
    const closed = new Promise<void>((resolve) => second.once("close", () => resolve()))
    second.write(encodeFrame({ kind: "bootstrap.claim", protocol: "rubato.remote.v1", token }))
    await bounded(closed)
  })
})

class SignalingJournal extends EventJournal {
  readonly #written: () => void
  constructor(journalPath: string, snapshotPath: string, written: () => void) {
    super(journalPath, snapshotPath, HOST_ID)
    this.#written = written
  }
  override async snapshot(...input: Parameters<EventJournal["snapshot"]>): ReturnType<EventJournal["snapshot"]> {
    const snapshot = await super.snapshot(...input)
    this.#written()
    return snapshot
  }
}

function launchPayload(): BootstrapLaunchPayload {
  return {
    schemaVersion: 1,
    liveSessionId: SESSION_ID,
    hostId: HOST_ID,
    zmxName: "rubato-018f1e2d3c4b",
    labels: { app: "rubato" },
    cwd: "/tmp",
    argv: ["hello"],
    env: { PATH: "/safe/bin" },
    launcherPath: "/rubato",
    zmxBinary: "/zmx",
    hubSocket: "/tmp/hub.sock",
    surfaceToken: "surface",
  }
}

function unmanagedSummary(): ReturnType<typeof summary> {
  const { zmxName: _zmxName, ...rest } = summary()
  return { ...rest, managed: false }
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once("connect", () => resolve(socket))
    socket.once("error", reject)
  })
}

function nextFrame(socket: Socket): Promise<unknown> {
  const decoder = new JsonFrameDecoder()
  return bounded(new Promise((resolve, reject) => {
    socket.on("data", function onData(chunk) {
      try {
        const values = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
        if (values.length > 0) {
          socket.off("data", onData)
          resolve(values[0])
        }
      } catch (error) {
        reject(error)
      }
    })
    socket.once("error", reject)
  }))
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("test signal timed out")), 2_000)
      timeout.unref()
    }),
  ])
}
