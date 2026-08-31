import { afterEach, describe, expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import { SessionActionQueue } from "../src/action-queue.js"
import { encodeFrame, JsonFrameDecoder, zmxNameForLiveSession, type BootstrapLaunchPayload } from "@rubato/remote-protocol"
import { EnvironmentHandoffStore, EnvironmentVault } from "../src/environment.js"
import { RemoteHub } from "../src/hub.js"
import { EventJournal } from "../src/journal.js"
import { PairingService } from "../src/pairing.js"
import { AllowedPathResolver } from "../src/path-security.js"
import { LiveRegistry, type LaunchRequest } from "../src/registry.js"
import { SurfaceReconnectCredentials } from "../src/surface-credentials.js"
import { SurfaceTokenStore } from "../src/surface-tokens.js"
import { SurfaceSocketServer } from "../src/unix-server.js"
import { HOST_ID, SESSION_ID, SESSION_2_ID, temporaryDirectory } from "./helpers.js"

const cleanupTasks: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup())))

describe("local CLI control protocol", () => {
  test("creates, lists, resolves, and kills while launch data exists only behind the hub token", async () => {
    const temporary = await temporaryDirectory()
    cleanupTasks.push(temporary.cleanup)
    const socketPath = join(temporary.path, "socket", "hub.sock")
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
    await journal.load()
    const launched: LaunchRequest[] = []
    const terminated: string[] = []
    const controller = {
      launch: async (request: LaunchRequest) => {
        launched.push(request)
        return { liveSessionId: request.liveSessionId, zmxName: "rubato-018f1e2d3c4b" as const, pid: 4242, labels: request.labels }
      },
      terminate: async (id: string) => { terminated.push(id) },
    }
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
    const surfaceTokens = new SurfaceTokenStore()
    const server = new SurfaceSocketServer(socketPath, registry, journal, surfaceTokens, handoffs, new SurfaceReconnectCredentials(join(temporary.path, "credential-key")))
    const vault = new EnvironmentVault(join(temporary.path, "launch-env.enc"), { getOrCreate: async () => Buffer.alloc(32) })
    const hub = new RemoteHub({
      registry,
      journal,
      actions: new SessionActionQueue(server, () => 0),
      controller,
      paths: new AllowedPathResolver([temporary.path]),
      vault,
      handoffs,
      surfaceTokens,
      newLiveSessionId: () => SESSION_ID,
      runtime: { socketPath, launcherPath: "/fixed/rubato", zmxBinary: "/fixed/zmx", buildId: "build-1" },
    })
    let pairingNow = Date.parse("2026-08-31T00:00:00.000Z")
    const pairing = new PairingService(join(temporary.path, "origins.json"), () => pairingNow)
    await pairing.load()
    server.setControl(hub, {
      pairing,
      pairingBaseUrl: async () => "https://mac.example.ts.net/rubato/",
      doctor: async () => ({ ok: false, checks: [{ id: "zmx", status: "fail", detail: "unavailable" }] }),
    })
    await server.listen()
    cleanupTasks.push(() => server.close())

    await request(socketPath, "cli.environment.save", { environment: { PATH: "/baseline/bin", PWD: "/excluded" } })
    expect(await vault.load()).toEqual({ PATH: "/baseline/bin" })

    const addHost = await request(socketPath, "cli.add-host") as { pairing: { nonce: string; expiresAt: string }; url: string; qrPayload: string }
    expect(JSON.parse(addHost.qrPayload)).toMatchObject({ type: "rubato-host-pair", baseUrl: "https://mac.example.ts.net/rubato/", hostId: HOST_ID })
    expect(addHost.url).toStartWith("https://mac.example.ts.net/rubato/?pair=")
    pairing.claim(addHost.pairing.nonce, "https://phone.example.ts.net", "owner@example.com")
    expect(() => pairing.claim(addHost.pairing.nonce, "https://phone.example.ts.net", "owner@example.com")).toThrow()
    const expiring = await request(socketPath, "cli.add-host") as { pairing: { nonce: string } }
    pairingNow += 10 * 60 * 1000 + 1
    expect(() => pairing.claim(expiring.pairing.nonce, "https://phone.example.ts.net", "owner@example.com")).toThrow()
    expect(await request(socketPath, "cli.doctor")).toEqual({ ok: false, checks: [{ id: "zmx", status: "fail", detail: "unavailable" }] })

    const created = await request(socketPath, "cli.create", {
      cwd: temporary.path,
      name: "Terminal",
      rubatoArgs: ["--session", "session.jsonl", "secret prompt"],
      environment: { PATH: "/terminal/bin", SECRET: "socket-only" },
    }) as { session: { liveSessionId: string; pid: number } }
    expect(created.session).toMatchObject({ liveSessionId: SESSION_ID, pid: 4242 })
    expect(launched).toHaveLength(1)
    expect(JSON.stringify(launched[0])).not.toContain("socket-only")
    const launch = handoffs.consume(launched[0]!.launchToken)
    expect(launch).toMatchObject({
      cwd: await realpath(temporary.path),
      argv: ["--session", "session.jsonl", "secret prompt"],
      env: { PATH: "/terminal/bin", SECRET: "socket-only" },
      hubSocket: socketPath,
    })
    expect(handoffs.consume(launched[0]!.launchToken)).toBeNull()

    const listed = await request(socketPath, "cli.list") as { sessions: Array<{ liveSessionId: string }> }
    expect(listed.sessions.map((entry) => entry.liveSessionId)).toEqual([SESSION_ID])
    const resolved = await request(socketPath, "cli.resolve", { value: SESSION_ID.slice(0, 8) }) as { session: { liveSessionId: string } }
    expect(resolved.session.liveSessionId).toBe(SESSION_ID)
    await request(socketPath, "cli.kill", { value: SESSION_ID, force: false })
    expect(terminated).toEqual([SESSION_ID])
  })

  test("mobile create decrypts the configured baseline instead of accepting request environment", async () => {
    const temporary = await temporaryDirectory()
    cleanupTasks.push(temporary.cleanup)
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
    await journal.load()
    const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
    const vault = new EnvironmentVault(join(temporary.path, "launch-env.enc"), { getOrCreate: async () => Buffer.alloc(32, 7) })
    await vault.save({ PATH: "/baseline/bin", MOBILE_SECRET: "encrypted", PWD: "/excluded" })
    let launchRequest: LaunchRequest | undefined
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    const hub = new RemoteHub({
      registry,
      journal,
      actions: new SessionActionQueue({ dispatch: async () => ({ accepted: true, revision: 0, payload: {} }) }, () => 0),
      controller: {
        launch: async (request) => {
          launchRequest = request
          return { liveSessionId: request.liveSessionId, zmxName: zmxNameForLiveSession(request.liveSessionId), labels: request.labels }
        },
        terminate: async () => {},
      },
      paths: new AllowedPathResolver([temporary.path]),
      vault,
      handoffs,
      surfaceTokens: new SurfaceTokenStore(),
      newLiveSessionId: () => SESSION_2_ID,
      runtime: { socketPath: "/tmp/hub.sock", launcherPath: "/rubato", zmxBinary: "/zmx", buildId: "test" },
    })
    await hub.create({ cwd: temporary.path, source: "mobile", environment: { MOBILE_SECRET: "request-value" } })
    const launch = handoffs.consume(launchRequest!.launchToken)
    expect(launch?.env).toEqual({ PATH: "/baseline/bin", MOBILE_SECRET: "encrypted" })
  })
})

async function request(path: string, kind: string, fields: Record<string, unknown> = {}): Promise<unknown> {
  const socket = await connect(path)
  const requestId = crypto.randomUUID()
  const response = nextFrame(socket)
  socket.write(encodeFrame({ kind, protocol: "rubato.remote.v1", requestId, ...fields }))
  const frame = await response as { ok: boolean; result?: unknown; error?: string }
  socket.destroy()
  if (!frame.ok) throw new Error(frame.error)
  return frame.result
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
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("control response timed out")), 2_000)
    timeout.unref()
    socket.on("data", function onData(chunk) {
      try {
        const values = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
        if (values.length === 0) return
        clearTimeout(timeout)
        socket.off("data", onData)
        resolve(values[0])
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
      }
    })
    socket.once("error", reject)
  })
}
