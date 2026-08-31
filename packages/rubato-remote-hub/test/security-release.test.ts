import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHttpApp } from "../src/http.js"
import { TailscaleServeIdentityVerifier } from "../src/identity.js"
import { AllowedPathResolver } from "../src/path-security.js"
import { TicketStore } from "../src/tickets.js"
import { HOST_ID, SESSION_ID, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("Stage 9 adversarial public boundaries", () => {
  test("does not trust spoofed Tailscale headers from LAN or unspecified peers", async () => {
    const verifier = new TailscaleServeIdentityVerifier()
    const headers = new Headers({ "tailscale-user-login": "owner@example.com", "tailscale-user-name": "Owner" })
    expect(await verifier.verify({ headers, remoteAddress: "192.168.1.20" })).toBeNull()
    expect(await verifier.verify({ headers, remoteAddress: undefined })).toBeNull()
    expect(await verifier.verify({ headers, remoteAddress: "127.0.0.1" })).toEqual({ login: "owner@example.com", name: "Owner" })
  })

  test("ticket replay, wrong Origin, wrong owner, and expiry all fail closed", () => {
    let now = 1_000
    const tickets = new TicketStore({ now: () => now })
    const wrongOrigin = tickets.issue("https://phone.ts.net", "owner@example.com")
    expect(tickets.consume(wrongOrigin.ticket, "https://evil.ts.net", "owner@example.com")).toBeFalse()
    const wrongOwner = tickets.issue("https://phone.ts.net", "owner@example.com")
    expect(tickets.consume(wrongOwner.ticket, "https://phone.ts.net", "shared@example.com")).toBeFalse()
    const replay = tickets.issue("https://phone.ts.net", "owner@example.com")
    expect(tickets.consume(replay.ticket, "https://phone.ts.net", "owner@example.com")).toBeTrue()
    expect(tickets.consume(replay.ticket, "https://phone.ts.net", "owner@example.com")).toBeFalse()
    const expired = tickets.issue("https://phone.ts.net", "owner@example.com")
    now += 15_001
    expect(tickets.consume(expired.ticket, "https://phone.ts.net", "owner@example.com")).toBeFalse()
  })

  test("realpath boundary rejects traversal and symlink escape even with malicious filenames", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const allowed = join(temporary.path, "allowed")
    const outside = join(temporary.path, "outside")
    await Promise.all([mkdir(allowed), mkdir(outside)])
    await writeFile(join(outside, "<img src=x onerror=alert(1)>.diff"), "secret")
    await symlink(outside, join(allowed, "escape"))
    const resolver = new AllowedPathResolver([allowed])
    await expect(resolver.resolve(join(allowed, "..", "outside", "<img src=x onerror=alert(1)>.diff"), "file")).rejects.toThrow("path_not_allowed")
    await expect(resolver.resolve(join(allowed, "escape", "<img src=x onerror=alert(1)>.diff"), "file")).rejects.toThrow("path_not_allowed")
  })

  test("rejects a declared 100 MiB action before reading or dispatching its body", async () => {
    let dispatched = false
    const origin = "https://phone.ts.net"
    const app = createHttpApp({
      config: { schemaVersion: 1, hostId: HOST_ID, displayName: "Mac", ownerLogin: "owner@example.com", httpPort: 7314, createdAt: new Date().toISOString() },
      hub: { actions: { enqueue: async () => { dispatched = true } } } as never,
      pairing: {
        isPaired: (value: string | undefined) => value === origin,
        corsHeaders: (value: string | undefined) => value === origin ? { "access-control-allow-origin": origin } : {},
        pairingCorsHeaders: () => ({}),
      } as never,
      tickets: {} as never,
      identity: { verify: async () => ({ login: "owner@example.com" }) },
      push: {} as never,
      terminalTickets: {} as never,
      remoteAddress: () => "127.0.0.1",
    })
    const response = await app.request(`http://localhost/rubato/api/v1/live/${SESSION_ID}/actions`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "content-length": String(100 * 1024 * 1024) },
      body: "{}",
    })
    expect(response.status).toBe(413)
    expect(dispatched).toBeFalse()
  })
})
