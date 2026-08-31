import { describe, expect, test } from "bun:test"
import * as protocolContract from "../src/index.js"
import {
  HTTP_REQUEST_SCHEMAS,
  HTTP_RESPONSE_SCHEMAS,
  REMOTE_HTTP_ROUTES,
  REMOTE_PROTOCOL_NAME,
  actionResultResponseSchema,
  artifactRequestSchema,
  artifactResponseSchema,
  bootstrapClaimFrameSchema,
  createLiveSessionRequestSchema,
  createLiveSessionResponseSchema,
  encryptedPushProfileSchema,
  fileReadRequestSchema,
  fileReadResponseSchema,
  gitDiffRequestSchema,
  gitDiffResponseSchema,
  gitStatusResponseSchema,
  healthResponseSchema,
  hostDescriptionResponseSchema,
  hostInventoryResponseSchema,
  hostInventorySchema,
  hubActionFrameSchema,
  hubLaunchFrameSchema,
  hubRegisteredFrameSchema,
  hubToSurfaceFrameSchema,
  imageUploadRequestSchema,
  imageUploadResponseSchema,
  messagePageRequestSchema,
  messagePageResponseSchema,
  pairApproveRequestSchema,
  pairApproveResponseSchema,
  pairClaimRequestSchema,
  pairClaimResponseSchema,
  pairingQrPayloadSchema,
  projectBrowseRequestSchema,
  projectBrowseResponseSchema,
  projectFavoritesUpdateRequestSchema,
  projectFavoritesUpdateResponseSchema,
  projectListResponseSchema,
  pushEnvelopeSchema,
  pushProfileExportRequestSchema,
  pushProfileImportResponseSchema,
  pushRotateResponseSchema,
  pushSubscribeRequestSchema,
  pushSubscribeResponseSchema,
  registeredHostSchema,
  sessionSnapshotSchema,
  sessionSnapshotStateSchema,
  snapshotResponseSchema,
  snapshotRequiredFrameSchema,
  surfaceActionResultFrameSchema,
  surfaceEventFrameSchema,
  surfaceHeartbeatFrameSchema,
  surfaceReconnectCredentialPayloadSchema,
  surfaceRegisterFrameSchema,
  surfaceSnapshotFrameSchema,
  surfaceToHubFrameSchema,
  terminalTicketRequestSchema,
  terminateLiveSessionRequestSchema,
  terminateLiveSessionResponseSchema,
  ticketResponseSchema,
  webSocketTicketRequestSchema,
} from "../src/index.js"

const HOST_ID = "018f0c7a-2f3b-7c4d-8e5f-1234567890ab"
const LIVE_ID = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab"
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000"
const SURFACE_ID = "123e4567-e89b-42d3-a456-426614174001"
const AT = "2026-08-31T01:00:02.000Z"
const { RemoteSurface } = await import(new URL("../../../harness/rubato-pi/src/extensions/remote-surface.mjs", import.meta.url).href)

const fixtureUrls = {
  host: new URL("./fixtures/host-description.v1.json", import.meta.url),
  browse: new URL("./fixtures/project-browse.v1.json", import.meta.url),
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
    ]
    expectValid(hubLaunchFrameSchema, hubFrames[0])
    expectValid(hubRegisteredFrameSchema, hubFrames[1])
    expectValid(hubActionFrameSchema, hubFrames[2])
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

describe("canonical host, pairing, and ticket contracts", () => {
  test("validates host description, inventory, pairing, and tickets", async () => {
    const hostDescription = await fixture("host")
    const registration = await fixture("register")
    const summary = registration["summary"]
    const registered = {
      hostId: HOST_ID,
      displayName: "Mac mini",
      baseUrl: "https://mac-mini.example.ts.net/rubato/",
      ownerLogin: "you@example.com",
      pairedAt: AT,
      lastSeenAt: AT,
      protocolMin: 1,
      protocolMax: 1,
    }
    expectValid(hostDescriptionResponseSchema, hostDescription)
    expectValid(registeredHostSchema, registered)
    expectValid(hostInventorySchema, { host: registered, sessions: [summary], connection: "online" })
    expectValid(hostInventoryResponseSchema, { hostSeq: 8, sessions: [summary] })
    expectValid(healthResponseSchema, { ok: true, hostId: HOST_ID })
    expectValid(pairingQrPayloadSchema, { type: "rubato-host-pair", baseUrl: registered.baseUrl, hostId: HOST_ID, nonce: "nonce", expiresAt: AT })
    expectValid(pairClaimRequestSchema, { nonce: "nonce" })
    expectValid(pairClaimResponseSchema, { claimId: REQUEST_ID, expiresAt: AT })
    expectValid(pairApproveRequestSchema, { claimId: REQUEST_ID, confirmed: true })
    expectValid(pairApproveResponseSchema, { paired: true, origin: "https://phone.example.ts.net" })
    expectValid(webSocketTicketRequestSchema, { purpose: "events" })
    expectValid(terminalTicketRequestSchema, { purpose: "terminal" })
    expectValid(ticketResponseSchema, { ticket: "one-time-ticket", expiresAt: AT })
  })

  test("rejects insecure hosts, partial ranges, and negotiation outside the advertised range", async () => {
    const host = await fixture("host")
    ;(host["negotiation"] as Record<string, unknown>)["version"] = 2
    expect(hostDescriptionResponseSchema.safeParse(host).ok).toBe(false)
    expect(registeredHostSchema.safeParse({
      hostId: HOST_ID, displayName: "Mac", baseUrl: "http://mac.local/rubato/", ownerLogin: "owner", pairedAt: AT,
    }).ok).toBe(false)
    expect(registeredHostSchema.safeParse({
      hostId: HOST_ID, displayName: "Mac", baseUrl: "https://mac.example/rubato/", ownerLogin: "owner", pairedAt: AT, protocolMin: 1,
    }).ok).toBe(false)
  })
})

describe("canonical session, project, file, artifact, and git HTTP contracts", () => {
  test("validates lifecycle and paged content contracts", async () => {
    const snapshot = await fixture("snapshot")
    expectValid(createLiveSessionRequestSchema, {
      cwd: "/Users/example/Projects/rubato",
      name: "Remote protocol",
      initialPrompt: "Complete the contracts",
      model: { provider: "openai", modelId: "gpt-5.6" },
      thinkingLevel: "high",
      attachAfterCreate: false,
      rubatoArgs: ["--no-update"],
    })
    expectValid(createLiveSessionResponseSchema, { liveSessionId: LIVE_ID, zmxName: "rubato-018f0c7b2f3b" })
    expectValid(terminateLiveSessionRequestSchema, { force: false })
    expectValid(terminateLiveSessionResponseSchema, { terminated: true })
    expectValid(actionResultResponseSchema, { accepted: true, revision: 124, payload: { queued: true } })
    const state = snapshot["state"] as Record<string, unknown>
    expectValid(snapshotResponseSchema, {
      summary: snapshot["summary"], revision: state["revision"], lastSeq: snapshot["lastSeq"], entries: state["entries"], tree: state["tree"],
      commands: state["commands"],
      uiRequest: { requestId: REQUEST_ID, kind: "select", title: "Choose", options: [{ label: "A", value: "a" }] },
    })
    expect(snapshotResponseSchema.safeParse({
      summary: snapshot["summary"], revision: state["revision"], lastSeq: snapshot["lastSeq"], entries: state["entries"], tree: state["tree"],
    }).ok).toBe(false)
    expectValid(messagePageRequestSchema, { before: "m1", limit: 100 })
    expectValid(messagePageResponseSchema, { entries: (snapshot["state"] as Record<string, unknown>)["entries"], nextBefore: "m0" })
  })

  test("validates images, artifacts, files, git, and project browsing", async () => {
    expectValid(imageUploadRequestSchema, { fileName: "screen.png", mimeType: "image/png", dataBase64: "aGVsbG8=" })
    expectValid(imageUploadResponseSchema, { imageId: "image-1", mimeType: "image/png", byteLength: 5 })
    expectValid(artifactRequestSchema, { artifactId: "artifact-1" })
    expectValid(artifactResponseSchema, { artifactId: "artifact-1", contentType: "text/plain", encoding: "utf8", content: "output", byteLength: 6, truncated: false })
    expectValid(fileReadRequestSchema, { path: "/Users/example/Projects/rubato/README.md", maxBytes: 65536 })
    expectValid(fileReadResponseSchema, { path: "/Users/example/Projects/rubato/README.md", content: "# Rubato", encoding: "utf8", byteLength: 8, truncated: false, language: "markdown" })
    expectValid(gitStatusResponseSchema, { files: [{ path: "/Users/example/Projects/rubato/src/a.ts", status: "modified" }] })
    expectValid(gitDiffRequestSchema, { path: "/Users/example/Projects/rubato/src/a.ts", contextLines: 3 })
    expectValid(gitDiffResponseSchema, { diff: { oldFile: { fileName: "a.ts", fileLang: "ts", content: "a" }, newFile: { fileName: "a.ts", fileLang: "ts", content: "b" }, hunks: ["@@ -1 +1 @@"] }, summary: "1 file changed" })

    const browse = await fixture("browse")
    expectValid(projectBrowseRequestSchema, { path: "/Users/example/Projects", showHidden: false, limit: 200 })
    expectValid(projectBrowseResponseSchema, browse)
    const projects = [{ path: "/Users/example/Projects/rubato", label: "Rubato", source: "favorite" }]
    expectValid(projectListResponseSchema, { projects })
    expectValid(projectFavoritesUpdateRequestSchema, { paths: ["/Users/example/Projects/rubato"] })
    expectValid(projectFavoritesUpdateResponseSchema, { projects })
  })
})

describe("canonical push transfer contracts", () => {
  const encrypted = { schemaVersion: 1, ephemeralPublicKey: "AQ==", salt: "Ag==", nonce: "Aw==", tag: "BA==", ciphertext: "BQ==" }

  test("validates subscription, encrypted transfer, rotation, and notification payloads", () => {
    expectValid(pushSubscribeRequestSchema, { subscription: { endpoint: "https://push.example/subscription", expirationTime: null, keys: { auth: "auth", p256dh: "key" } } })
    expectValid(pushSubscribeResponseSchema, { vapidPublicKey: "vapid", createdAt: AT })
    expectValid(pushProfileExportRequestSchema, { destinationPublicKey: "AQ==" })
    expectValid(encryptedPushProfileSchema, encrypted)
    expectValid(pushProfileImportResponseSchema, { imported: true, pwaOrigin: "https://phone.example.ts.net" })
    expectValid(pushRotateResponseSchema, { requiresResubscribe: true, vapidPublicKey: "next-vapid" })
    expectValid(pushEnvelopeSchema, { type: "attention-required", hostId: HOST_ID, liveSessionId: LIVE_ID, title: "Input needed", body: "Choose an option", url: "/rubato/session" })
  })

  test("exports complete request and response schema registries", () => {
    expect(Object.keys(HTTP_REQUEST_SCHEMAS).sort()).toEqual([
      "action", "artifact", "createLiveSession", "fileRead", "gitDiff", "imageUpload", "messagePage", "pairApprove", "pairClaim",
      "projectBrowse", "projectFavoritesUpdate", "pushProfileExport", "pushProfileImport", "pushSubscribe", "terminalTicket",
      "terminateLiveSession", "webSocketTicket",
    ])
    expect(Object.keys(HTTP_RESPONSE_SCHEMAS)).toContain("snapshot")
    expect(Object.keys(HTTP_RESPONSE_SCHEMAS)).toContain("pushProfileExport")
    expect(REMOTE_HTTP_ROUTES.snapshot).toBe("/rubato/api/v1/live/:liveSessionId/snapshot")
    expect(REMOTE_HTTP_ROUTES.projectsBrowse).toBe("/rubato/api/v1/projects/browse")
  })

  test("strict schemas reject unknown nested fields", () => {
    const request = { subscription: { endpoint: "https://push.example/subscription", keys: { auth: "auth", p256dh: "key", secret: "leak" } } }
    const result = pushSubscribeRequestSchema.safeParse(request)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(({ path }) => path)).toContain("$.subscription.keys.secret")
  })
})
