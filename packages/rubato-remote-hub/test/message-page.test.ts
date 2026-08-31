import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ActionRequestEnvelope, ActionResultResponse, BootstrapLaunchPayload } from "@rubato/remote-protocol"
import { TerminalLaunchTicketStore } from "@rubato/terminal-bridge"
import { SessionActionQueue } from "../src/action-queue.js"
import { EnvironmentHandoffStore, EnvironmentVault } from "../src/environment.js"
import { RemoteHub } from "../src/hub.js"
import { createHttpApp } from "../src/http.js"
import { EventJournal } from "../src/journal.js"
import { PairingService } from "../src/pairing.js"
import { AllowedPathResolver } from "../src/path-security.js"
import { PushProfileStore, type PushTransport } from "../src/push.js"
import { LiveRegistry } from "../src/registry.js"
import { SurfaceTokenStore } from "../src/surface-tokens.js"
import { TicketStore } from "../src/tickets.js"
import { HOST_ID, SESSION_ID, summary, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

const v2Page = {
  entries: [{
    id: "m1",
    kind: "message" as const,
    role: "assistant" as const,
    text: "Done.",
    requestRunId: "legacy:m1",
    phase: "final" as const,
  }],
  requestRuns: [{
    id: "legacy:m1",
    status: "completed" as const,
    rootUserMessageId: "u1",
    startedAt: "2026-08-31T00:59:20.000Z",
    progressMessageCount: 1,
    toolCount: 0,
    failedToolCount: 0,
    steeringCount: 0,
  }],
  nextBefore: "u1",
}

describe("GET /messages", () => {
  test("projects v1 by default and keeps requestRuns for protocol 2", async () => {
    const { app, headers } = await appFor(async (request) => {
      expect(request.action).toBe("conversation.page")
      expect(request.payload).toEqual({ limit: 50, before: "cursor" })
      return { accepted: true, revision: 1, payload: v2Page }
    })
    const v1 = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/messages?before=cursor`, { headers })
    expect(v1.status).toBe(200)
    expect(await v1.json()).toEqual({
      entries: [{ id: "m1", kind: "message", role: "assistant", text: "Done." }],
      nextBefore: "u1",
    })
    const v2 = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/messages?protocolVersion=2&before=cursor&limit=50`, { headers })
    expect(v2.status).toBe(200)
    expect(await v2.json()).toEqual(v2Page)
  })

  test("rejects unsupported protocol versions and unknown sessions", async () => {
    const { app, headers } = await appFor(async () => ({ accepted: true, revision: 1, payload: { entries: [] } }))
    const mismatch = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/messages?protocolVersion=3`, { headers })
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toMatchObject({ error: { code: "protocol_mismatch" } })
    const missing = await app.request("http://localhost/rubato/api/v1/live/018f1e2d-3c4b-7d6f-8abc-1234567890ab/messages", { headers })
    expect(missing.status).toBe(404)
  })

  test("maps an unknown cursor to invalid_action", async () => {
    const { app, headers } = await appFor(async () => ({ accepted: false, revision: 1, payload: { error: { code: "invalid_action" } } }))
    const response = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/messages?before=missing`, { headers })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "invalid_action" } })
  })
})

async function appFor(dispatch: (request: ActionRequestEnvelope) => Promise<ActionResultResponse>) {
  const temporary = await temporaryDirectory()
  cleanups.push(temporary.cleanup)
  const pairing = new PairingService(join(temporary.path, "origins.json"))
  await pairing.load()
  const nonce = pairing.issueNonce()
  const claim = pairing.claim(nonce.nonce, "https://phone.example.ts.net", "owner@example.com")
  await pairing.approve(claim.claimId, "owner@example.com", true)
  const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
  await journal.load()
  const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
  registry.trackStarting(summary())
  const actions = new SessionActionQueue({ dispatch: async (request) => dispatch(request) }, () => 0)
  const hub = new RemoteHub({
    registry,
    journal,
    actions,
    controller: {
      launch: async () => ({ liveSessionId: SESSION_ID, zmxName: "rubato-018f1e2d3c4b", labels: {} }),
      terminate: async () => {},
    },
    paths: new AllowedPathResolver([temporary.path]),
    vault: new EnvironmentVault(join(temporary.path, "env.enc"), { getOrCreate: async () => Buffer.alloc(32) }),
    handoffs: new EnvironmentHandoffStore<BootstrapLaunchPayload>(),
    surfaceTokens: new SurfaceTokenStore(),
    newLiveSessionId: () => SESSION_ID,
  })
  const push = new PushProfileStore(join(temporary.path, "push"), { send: async () => {} } satisfies PushTransport)
  await push.load()
  const app = createHttpApp({
    config: { schemaVersion: 1, hostId: HOST_ID, displayName: "Mac", ownerLogin: "owner@example.com", httpPort: 7314, createdAt: new Date().toISOString() },
    hub,
    pairing,
    tickets: new TicketStore(),
    terminalTickets: new TerminalLaunchTicketStore(),
    identity: { verify: async ({ headers }) => headers.get("tailscale-user-login") === "owner@example.com" ? { login: "owner@example.com" } : null },
    push,
    remoteAddress: () => "127.0.0.1",
  })
  return { app, headers: { origin: "https://phone.example.ts.net", "tailscale-user-login": "owner@example.com", "content-type": "application/json" } }
}
