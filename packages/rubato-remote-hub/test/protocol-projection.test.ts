import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { snapshotResponseSchema, type BootstrapLaunchPayload } from "@rubato/remote-protocol"
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

describe("HTTP protocol projection", () => {
  test("strips presentation and timeline unless protocolVersion=2", async () => {
    const { app, headers } = await appFor()
    const v1 = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/snapshot`, { headers })
    expect(v1.status).toBe(200)
    const parsed = snapshotResponseSchema.parse(await v1.json())
    expect(parsed.summary).not.toHaveProperty("presentation")
    expect(parsed).not.toHaveProperty("timeline")
    expect(parsed.entries[0]).toEqual({ id: "m1", kind: "message", role: "assistant", text: "Done." })

    const v2 = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/snapshot?protocolVersion=2`, { headers })
    const body = await v2.json() as { summary: { presentation?: unknown }; timeline?: unknown; entries: Array<Record<string, unknown>> }
    expect(body.summary.presentation).toEqual({
      schemaVersion: 1,
      lastFinalResponsePreview: "Done.",
      pendingFollowUpCount: 0,
      pendingSteerCount: 0,
    })
    expect(body.timeline).toBeDefined()
    expect(body.entries[0]).toMatchObject({ requestRunId: "run-1", phase: "final" })

    const inventory = await app.request("http://localhost/rubato/api/v1/inventory", { headers })
    const listed = await inventory.json() as { sessions: Array<Record<string, unknown>> }
    expect(listed.sessions[0]).not.toHaveProperty("presentation")
  })
})

async function appFor() {
  const temporary = await temporaryDirectory()
  cleanups.push(temporary.cleanup)
  const pairing = new PairingService(join(temporary.path, "origins.json"))
  await pairing.load()
  const nonce = pairing.issueNonce()
  const claim = pairing.claim(nonce.nonce, "https://phone.example.ts.net", "owner@example.com")
  await pairing.approve(claim.claimId, "owner@example.com", true)
  const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
  await journal.load()
  const live = summary({
    presentation: {
      schemaVersion: 1,
      lastFinalResponsePreview: "Done.",
      pendingFollowUpCount: 0,
      pendingSteerCount: 0,
    },
  })
  await journal.snapshot(live, {
    revision: 3,
    entries: [{ id: "m1", kind: "message", role: "assistant", text: "Done.", requestRunId: "run-1", phase: "final" }],
    tree: [],
    commands: [],
    capabilities: [],
    timeline: { schemaVersion: 1, runs: [], pendingInputs: [], hasOlder: false },
  })
  const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
  registry.trackStarting(live)
  const hub = new RemoteHub({
    registry,
    journal,
    actions: new SessionActionQueue({ dispatch: async () => ({ accepted: true, revision: 1, payload: {} }) }, () => 0),
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
  return {
    app: createHttpApp({
      config: { schemaVersion: 1, hostId: HOST_ID, displayName: "Mac", ownerLogin: "owner@example.com", httpPort: 7314, createdAt: new Date().toISOString() },
      hub,
      pairing,
      tickets: new TicketStore(),
      terminalTickets: new TerminalLaunchTicketStore(),
      identity: { verify: async ({ headers }) => headers.get("tailscale-user-login") === "owner@example.com" ? { login: "owner@example.com" } : null },
      push,
      remoteAddress: () => "127.0.0.1",
    }),
    headers: { origin: "https://phone.example.ts.net", "tailscale-user-login": "owner@example.com", "content-type": "application/json" },
  }
}
