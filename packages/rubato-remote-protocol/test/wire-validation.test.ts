import { describe, expect, test } from "bun:test"
import * as protocolContract from "../src/index.js"
import {
  REMOTE_PROTOCOL_NAME,
  actionResultResponseSchema,
  bootstrapClaimFrameSchema,
  hubActionFrameSchema,
  hubLaunchFrameSchema,
  hubRegisteredFrameSchema,
  hubRejectedFrameSchema,
  hubToSurfaceFrameSchema,
  pairingQrPayloadSchema,
  sessionSnapshotSchema,
  sessionSnapshotStateSchema,
  snapshotRequiredFrameSchema,
  surfaceActionResultFrameSchema,
  surfaceEventFrameSchema,
  surfaceHeartbeatFrameSchema,
  surfaceReconnectCredentialPayloadSchema,
  surfaceRegisterFrameSchema,
  surfaceSnapshotFrameSchema,
  surfaceToHubFrameSchema,
} from "../src/index.js"

const HOST_ID = "018f0c7a-2f3b-7c4d-8e5f-1234567890ab"
const LIVE_ID = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab"
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000"
const SURFACE_ID = "123e4567-e89b-42d3-a456-426614174001"
const AT = "2026-08-31T01:00:02.000Z"
const { RemoteSurface } = await import(new URL("../../../harness/rubato-pi/src/extensions/remote-surface.mjs", import.meta.url).href)

const fixtureUrls = {
  register: new URL("./fixtures/surface-register.v1.json", import.meta.url),
  event: new URL("./fixtures/surface-event.v1.json", import.meta.url),
  snapshot: new URL("./fixtures/session-snapshot.v1.json", import.meta.url),
  action: new URL("./fixtures/action-request.v1.json", import.meta.url),
}

async function fixture(name: keyof typeof fixtureUrls): Promise<Record<string, unknown>> {
  return Bun.file(fixtureUrls[name]).json() as Promise<Record<string, unknown>>
}

function expectValid(schema: { safeParse(value: unknown): { ok: boolean } }, value: unknown): void {
  expect(schema.safeParse(value).ok).toBe(true)
}

describe("canonical surface and bootstrap frames", () => {
  test("published surface fixtures are strict canonical frames", async () => {
    expectValid(surfaceRegisterFrameSchema, await fixture("register"))
    expectValid(surfaceEventFrameSchema, await fixture("event"))
    expectValid(surfaceToHubFrameSchema, await fixture("register"))
    expectValid(surfaceToHubFrameSchema, await fixture("event"))
  })

  test("validates every process-to-hub and hub-to-process wrapper", async () => {
    const snapshot = await fixture("snapshot")
    const summary = snapshot["summary"]
    const action = await fixture("action")
    const frames = [
      { kind: "bootstrap.claim", protocol: REMOTE_PROTOCOL_NAME, token: "launch-token" },
      { kind: "surface.heartbeat", protocol: REMOTE_PROTOCOL_NAME, surfaceInstanceId: SURFACE_ID, sourceSeq: 0, at: AT },
      { kind: "surface.snapshot", protocol: REMOTE_PROTOCOL_NAME, surfaceInstanceId: SURFACE_ID, sourceSeq: 42, at: AT, summary, state: snapshot["state"] },
      { kind: "surface.action-result", protocol: REMOTE_PROTOCOL_NAME, requestId: REQUEST_ID, accepted: true, revision: 123, payload: { queued: true } },
    ]
    expectValid(bootstrapClaimFrameSchema, frames[0])
    expectValid(surfaceHeartbeatFrameSchema, frames[1])
    expectValid(surfaceSnapshotFrameSchema, frames[2])
    expectValid(surfaceActionResultFrameSchema, frames[3])
    for (const frame of frames) expectValid(surfaceToHubFrameSchema, frame)

    const hubFrames = [
      { kind: "hub.launch", protocol: REMOTE_PROTOCOL_NAME, launch: {
        schemaVersion: 1, liveSessionId: LIVE_ID, hostId: HOST_ID, zmxName: "rubato-018f0c7b2f3b",
        labels: { app: "rubato", rubato_protocol: "1" }, cwd: "/Users/example/Projects/hotel-tablet", argv: ["--model", "gpt-5.6"],
        env: { PATH: "/usr/bin", LANG: "en_US.UTF-8" }, launcherPath: "/opt/rubato/bin/rubato-pi.sh",
        zmxBinary: "/opt/rubato/bin/zmx", hubSocket: "/Users/example/.rubato/remote/hub.sock", surfaceToken: "surface-token",
      } },
      { kind: "hub.registered", protocol: REMOTE_PROTOCOL_NAME, hostSeq: 9, reconnectToken: "reconnect-token", protocolRange: { min: 1, max: 1 }, negotiation: { compatible: true, version: 1 } },
      { kind: "hub.action", protocol: REMOTE_PROTOCOL_NAME, request: action },
      { kind: "hub.rejected", protocol: REMOTE_PROTOCOL_NAME, reason: "$.state.timeline: is not allowed" },
    ]
    expectValid(hubLaunchFrameSchema, hubFrames[0])
    expectValid(hubRegisteredFrameSchema, hubFrames[1])
    expectValid(hubActionFrameSchema, hubFrames[2])
    expectValid(hubRejectedFrameSchema, hubFrames[3])
    for (const frame of hubFrames) expectValid(hubToSurfaceFrameSchema, frame)
  })

  test("validates reconnect credentials and snapshot-required replay wrappers", async () => {
    const snapshot = await fixture("snapshot")
    expectValid(surfaceReconnectCredentialPayloadSchema, {
      schemaVersion: 1,
      liveSessionId: LIVE_ID,
      surfaceInstanceId: SURFACE_ID,
      expiresAt: 1_800_000_000_000,
      nonce: "credential-nonce",
    })
    expectValid(sessionSnapshotSchema, snapshot)
    expectValid(snapshotRequiredFrameSchema, {
      type: "snapshot.required",
      protocol: REMOTE_PROTOCOL_NAME,
      liveSessionId: LIVE_ID,
      snapshot,
    })
  })

  test("requires credentials, exact keys, identity consistency, and N/N-1 ranges", async () => {
    const registration = await fixture("register")
    const noCredential = structuredClone(registration)
    delete noCredential["token"]
    expect(surfaceRegisterFrameSchema.safeParse(noCredential).ok).toBe(false)

    const tooWide = structuredClone(registration)
    tooWide["protocolRange"] = { min: 1, max: 3 }
    ;(tooWide["summary"] as Record<string, unknown>)["build"] = { piVersion: "1", remoteProtocolMin: 1, remoteProtocolMax: 3 }
    expect(surfaceRegisterFrameSchema.safeParse(tooWide).ok).toBe(false)

    const future = structuredClone(registration)
    future["protocolRange"] = { min: 2, max: 3 }
    ;(future["summary"] as Record<string, unknown>)["build"] = { piVersion: "1", remoteProtocolMin: 2, remoteProtocolMax: 3 }
    expect(surfaceRegisterFrameSchema.safeParse(future).ok).toBe(true)

    const snapshot = await fixture("snapshot")
    snapshot["liveSessionId"] = HOST_ID
    expect(sessionSnapshotSchema.safeParse(snapshot).ok).toBe(false)

    const event = await fixture("event")
    event["unexpected"] = true
    expect(surfaceEventFrameSchema.safeParse(event).ok).toBe(false)

    const snapshotState = (await fixture("snapshot"))["state"] as Record<string, unknown>
    const missingCommands = structuredClone(snapshotState)
    delete missingCommands["commands"]
    expect(sessionSnapshotStateSchema.safeParse(missingCommands).ok).toBe(false)
    const commandWithExtra = structuredClone(snapshotState)
    ;((commandWithExtra["commands"] as Record<string, unknown>[])[0] as Record<string, unknown>)["source"] = "builtin"
    expect(sessionSnapshotStateSchema.safeParse(commandWithExtra).ok).toBe(false)
  })

  test("the Pi surface emits only frames accepted by the canonical schemas", async () => {
    const sent: unknown[] = []
    const commands = [
      { name: "skill:review", description: "Review changes", category: "skill", remoteMode: "direct" },
      { name: "compact", description: "Compact context", category: "builtin", remoteMode: "native-action" },
      { name: "login", description: "Configure authentication", category: "builtin", remoteMode: "terminal-only" },
      { name: "release", description: "Run release prompt", category: "template", remoteMode: "direct" },
    ]
    const control = {
      snapshot: () => ({ leafEntryId: "m1", sessionName: "Contract", uiRequest: { id: REQUEST_ID, kind: "select", title: "Choose", options: ["A"] } }),
      listCommands: () => commands,
      submitInput: async () => ({ accepted: true }),
    }
    const surface = new RemoteSurface({
      getInteractiveControl: () => control,
      getSessionName: () => "Contract",
    }, protocolContract, {
      hostId: HOST_ID,
      liveSessionId: LIVE_ID,
      surfaceInstanceId: SURFACE_ID,
      surfaceToken: "surface-token",
      connect: async () => ({ send: (frame: unknown) => sent.push(frame), close() {} }),
      clock: { now: () => Date.parse(AT), setTimeout, clearTimeout, setInterval, clearInterval },
    })
    surface.context = {
      cwd: "/Users/example/Projects/rubato",
      sessionManager: {
        getSessionId: () => "pi-session",
        getSessionName: () => "Contract",
        getBranch: () => [{ id: "m1", parentId: null, type: "message", timestamp: AT, message: { role: "user", content: "hello" } }],
        getTree: () => [{ entry: { id: "m1", parentId: null, type: "message", timestamp: AT, message: { role: "user", content: "hello" } }, children: [] }],
      },
    }

    await surface.connectNow()
    expectValid(surfaceToHubFrameSchema, sent[0])
    await surface.receive({
      kind: "hub.registered", protocol: REMOTE_PROTOCOL_NAME, hostSeq: 1, reconnectToken: "reconnect-token",
      protocolRange: { min: 1, max: 1 }, negotiation: { compatible: true, version: 1 },
    })
    surface.send({ kind: "surface.heartbeat", protocol: REMOTE_PROTOCOL_NAME, surfaceInstanceId: SURFACE_ID, sourceSeq: surface.sourceSeq, at: AT })
    surface.emit("message.delta", { delta: "x" })
    surface.emitSnapshot()
    await surface.receive({ kind: "hub.action", protocol: REMOTE_PROTOCOL_NAME, request: {
      protocol: REMOTE_PROTOCOL_NAME, requestId: REQUEST_ID, hostId: HOST_ID, liveSessionId: LIVE_ID,
      action: "input.submit", payload: { text: "continue" },
    } })

    for (const frame of sent) expectValid(surfaceToHubFrameSchema, frame)
    const snapshot = sent.find((frame) => (frame as { kind?: string }).kind === "surface.snapshot") as { state: { commands: unknown[] } }
    expect(snapshot.state.commands).toEqual(commands)

    const reconnect: unknown[] = []
    surface.connection = undefined
    surface.connect = async () => ({ send: (frame: unknown) => reconnect.push(frame), close() {} })
    await surface.connectNow()
    expectValid(surfaceToHubFrameSchema, reconnect[0])
    expect(reconnect[0]).toMatchObject({ kind: "surface.register", reconnectToken: "reconnect-token" })
    expect(reconnect[0]).not.toHaveProperty("token")
  })
})

describe("canonical pairing QR payloads", () => {
  test("validates add-host pairing QR payloads and rejects insecure base URLs", () => {
    expectValid(pairingQrPayloadSchema, {
      type: "rubato-host-pair",
      baseUrl: "https://mac-mini.example.ts.net/rubato/",
      hostId: HOST_ID,
      nonce: "nonce",
      expiresAt: AT,
    })
    expect(pairingQrPayloadSchema.safeParse({
      type: "rubato-host-pair",
      baseUrl: "http://mac.local/rubato/",
      hostId: HOST_ID,
      nonce: "nonce",
      expiresAt: AT,
    }).ok).toBe(false)
    expectValid(actionResultResponseSchema, { accepted: true, revision: 124, payload: { queued: true } })
  })
})
