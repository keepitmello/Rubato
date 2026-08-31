import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { PairingService } from "../src/pairing.js"
import { TicketStore } from "../src/tickets.js"
import { temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("pairing, exact CORS, and websocket tickets", () => {
  test("requires a valid one-use nonce and explicit approval before echoing exact Origin", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    let now = 1_000
    const pairing = new PairingService(join(temporary.path, "origins.json"), () => now)
    await pairing.load()
    const issued = pairing.issueNonce()
    const claim = pairing.claim(issued.nonce, "https://phone.example.ts.net", "owner@example.com")

    expect(() => pairing.claim(issued.nonce, "https://evil.example", "owner@example.com")).toThrow()
    expect(pairing.isPaired("https://phone.example.ts.net")).toBeFalse()
    await expect(pairing.approve(claim.claimId, "owner@example.com", false)).rejects.toThrow()
    await pairing.approve(claim.claimId, "owner@example.com", true)

    expect(pairing.corsHeaders("https://phone.example.ts.net")).toEqual(expect.objectContaining({
      "access-control-allow-origin": "https://phone.example.ts.net",
    }))
    expect(pairing.corsHeaders("https://phone.example.ts.net.evil")).toEqual({})

    const reloaded = new PairingService(join(temporary.path, "origins.json"), () => now)
    await reloaded.load()
    expect(reloaded.isPaired("https://phone.example.ts.net")).toBeTrue()
    now += 10 * 60 * 1000 + 1
    expect(() => pairing.claim(pairing.issueNonce(1).nonce, "https://other.example", "owner@example.com")).not.toThrow()
  })

  test("binds 15-second tickets to owner and Origin and consumes them once", () => {
    let now = 10_000
    const tickets = new TicketStore({ now: () => now })
    const issued = tickets.issue("https://phone.example.ts.net", "owner@example.com")
    expect(tickets.consume(issued.ticket, "https://other.example", "owner@example.com")).toBeFalse()

    const second = tickets.issue("https://phone.example.ts.net", "owner@example.com")
    expect(tickets.consume(second.ticket, "https://phone.example.ts.net", "owner@example.com")).toBeTrue()
    expect(tickets.consume(second.ticket, "https://phone.example.ts.net", "owner@example.com")).toBeFalse()

    const expired = tickets.issue("https://phone.example.ts.net", "owner@example.com")
    now += 15_001
    expect(tickets.consume(expired.ticket, "https://phone.example.ts.net", "owner@example.com")).toBeFalse()
  })
})
