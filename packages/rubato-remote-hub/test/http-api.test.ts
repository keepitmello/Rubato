import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
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

describe("HTTP security and ticket API", () => {
  test("negotiates capabilities and issues a short-lived ticket only to paired owner origin", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const webRoot = join(temporary.path, "web")
    await mkdir(join(webRoot, "assets"), { recursive: true })
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Rubato Remote</title>")
    await writeFile(join(webRoot, "assets", "app-abcdef.js"), "globalThis.rubatoRemote = true")
    const pairing = new PairingService(join(temporary.path, "origins.json"))
    await pairing.load()
    const nonce = pairing.issueNonce()
    const claim = pairing.claim(nonce.nonce, "https://phone.example.ts.net", "owner@example.com")
    await pairing.approve(claim.claimId, "owner@example.com", true)
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
    await journal.load()
    const command = { name: "compact", description: "Compact conversation context", category: "builtin" as const, remoteMode: "native-action" as const }
    await journal.snapshot(summary(), { revision: 7, entries: [], tree: [], commands: [command], capabilities: [] })
    const registry = new LiveRegistry(HOST_ID, { discover: async () => [] })
    registry.trackStarting(summary())
    const actions = new SessionActionQueue({ dispatch: async () => ({ accepted: true, revision: 1, payload: {} }) }, () => 0)
    const handoffs = new EnvironmentHandoffStore<BootstrapLaunchPayload>()
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
      handoffs,
      surfaceTokens: new SurfaceTokenStore(),
      newLiveSessionId: () => SESSION_ID,
    })
    const push = new PushProfileStore(join(temporary.path, "push"), { send: async () => {} } satisfies PushTransport)
    await push.load()
    const tickets = new TicketStore()
    const terminalTickets = new TerminalLaunchTicketStore()
    const app = createHttpApp({
      config: { schemaVersion: 1, hostId: HOST_ID, displayName: "Mac", ownerLogin: "owner@example.com", httpPort: 7314, createdAt: new Date().toISOString() },
      hub,
      pairing,
      tickets,
      terminalTickets,
      identity: { verify: async ({ headers }) => headers.get("tailscale-user-login") === "owner@example.com" ? { login: "owner@example.com" } : null },
      push,
      webRoot,
      remoteAddress: () => "127.0.0.1",
    })
    const headers = { origin: "https://phone.example.ts.net", "tailscale-user-login": "owner@example.com", "content-type": "application/json" }

    const host = await app.request("http://localhost/rubato/api/v1/host?protocolMin=1&protocolMax=2", { headers })
    expect(host.status).toBe(200)
    expect(await host.json()).toMatchObject({ negotiation: { compatible: true, version: 2 } })
    const sameOriginHost = await app.request("https://phone.example.ts.net/rubato/api/v1/host?protocolMin=1&protocolMax=2", {
      headers: { "tailscale-user-login": "owner@example.com" },
    })
    expect(sameOriginHost.status).toBe(200)

    const shell = await app.request("http://localhost/rubato/session/example")
    expect(shell.status).toBe(200)
    expect(shell.headers.get("content-type")).toContain("text/html")
    expect(await shell.text()).toContain("Rubato Remote")
    const asset = await app.request("http://localhost/rubato/assets/app-abcdef.js")
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(await asset.text()).toContain("rubatoRemote")
    expect((await app.request("http://localhost/rubato/assets/missing.js")).status).toBe(404)
    expect((await app.request("http://localhost/rubato/api/v1/missing", { headers })).status).toBe(404)
    const recentProjects = await app.request("http://localhost/rubato/api/v1/projects/recent", { headers })
    expect(recentProjects.status).toBe(200)
    expect(await recentProjects.json()).toEqual({ projects: [{ path: summary().cwd, label: summary().cwd.split("/").at(-1), source: "recent" }] })
    const favoriteProjects = await app.request("http://localhost/rubato/api/v1/projects/favorites", { headers })
    expect(favoriteProjects.status).toBe(200)
    expect(await favoriteProjects.json()).toEqual({ projects: [] })

    const subscription = { endpoint: "https://push.example/private-token", keys: { auth: "auth", p256dh: "p256dh" } }
    const subscribed = await app.request("http://localhost/rubato/api/v1/push/subscribe", { method: "POST", headers, body: JSON.stringify({ subscription }) })
    expect(subscribed.status).toBe(200)
    const promptLeak = await app.request("http://localhost/rubato/api/v1/push/subscription", { method: "DELETE", headers, body: JSON.stringify({ endpoint: subscription.endpoint, prompt: "private prompt" }) })
    expect(promptLeak.status).toBe(400)
    expect(push.profile()).not.toBeNull()
    const unsubscribed = await app.request("http://localhost/rubato/api/v1/push/subscription", { method: "DELETE", headers, body: JSON.stringify({ endpoint: subscription.endpoint }) })
    expect(unsubscribed.status).toBe(200)
    expect(await unsubscribed.json()).toEqual({ revoked: true })
    expect(push.profile()).toBeNull()

    const snapshotResponse = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/snapshot`, { headers })
    expect(snapshotResponse.status).toBe(200)
    const parsedSnapshot = snapshotResponseSchema.parse(await snapshotResponse.json())
    expect(parsedSnapshot.commands).toEqual([command])
    expect(parsedSnapshot.revision).toBe(7)

    const ticketResponse = await app.request("http://localhost/rubato/api/v1/auth/ticket", { method: "POST", headers, body: JSON.stringify({ purpose: "events" }) })
    expect(ticketResponse.status).toBe(200)
    expect(ticketResponse.headers.get("access-control-allow-origin")).toBe("https://phone.example.ts.net")
    const issued = await ticketResponse.json() as { ticket: string }
    expect(tickets.consume(issued.ticket, "https://phone.example.ts.net", "owner@example.com")).toBeTrue()

    for (let attempt = 0; attempt < 3; attempt++) {
      const terminal = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/terminal/ticket`, { method: "POST", headers, body: JSON.stringify({ purpose: "terminal" }) })
      expect(terminal.status).toBe(200)
      const launch = await terminal.json() as { ticket: string; expiresAt: string }
      expect(terminalTickets.consume(launch.ticket, { origin: "https://phone.example.ts.net", ownerLogin: "owner@example.com", zmxName: "rubato-018f1e2d3c4b" })).toBeTrue()
    }
    const limited = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/terminal/ticket`, { method: "POST", headers, body: JSON.stringify({ purpose: "terminal" }) })
    expect(limited.status).toBe(429)
    const missing = await app.request("http://localhost/rubato/api/v1/live/018f1e2d-3c4b-7d6f-8abc-1234567890ab/terminal/ticket", { method: "POST", headers, body: JSON.stringify({ purpose: "terminal" }) })
    expect(missing.status).toBe(404)

    const evil = await app.request("http://localhost/rubato/api/v1/inventory", { headers: { ...headers, origin: "https://evil.example" } })
    expect(evil.status).toBe(403)
    expect(evil.headers.get("access-control-allow-origin")).toBeNull()
    const evilSimpleMutation = await app.request("http://localhost/rubato/api/v1/push/rotate", {
      method: "POST",
      headers: { host: "phone.example.ts.net", origin: "https://evil.example", "tailscale-user-login": "owner@example.com", "content-type": "text/plain" },
    })
    expect(evilSimpleMutation.status).toBe(403)
  })
})
