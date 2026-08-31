import { describe, expect, test } from "bun:test"
import { TerminalLaunchTicketStore, TERMINAL_TICKET_TTL_MS } from "../src/index.js"

const identity = {
  origin: "https://phone.example.test",
  ownerLogin: "owner@example.test",
  zmxName: "rubato-018f1e2d3c4b",
}

describe("terminal launch tickets", () => {
  test("are bound, single-use, and valid for at most 30 seconds", () => {
    let now = 1_800_000_000_000
    const store = new TerminalLaunchTicketStore({ now: () => now })
    const issued = store.issue(identity)
    expect(issued.expiresAt).toBe(new Date(now + TERMINAL_TICKET_TTL_MS).toISOString())
    expect(store.consume(issued.ticket, identity)).toBe(true)
    expect(store.consume(issued.ticket, identity)).toBe(false)

    const expiring = store.issue(identity)
    now += TERMINAL_TICKET_TTL_MS
    expect(store.consume(expiring.ticket, identity)).toBe(false)
  })

  test("consumes a ticket on identity mismatch to prevent replay against another binding", () => {
    const store = new TerminalLaunchTicketStore()
    const issued = store.issue(identity)
    expect(store.consume(issued.ticket, { ...identity, zmxName: "rubato-aaaaaaaaaaaa" })).toBe(false)
    expect(store.consume(issued.ticket, identity)).toBe(false)
  })

  test("rejects non-HTTPS origins, noncanonical names, malformed tickets, and TTL extension", () => {
    expect(() => new TerminalLaunchTicketStore({ ttlMs: TERMINAL_TICKET_TTL_MS + 1 })).toThrow("TTL")
    const store = new TerminalLaunchTicketStore()
    expect(() => store.issue({ ...identity, origin: "http://phone.example.test" })).toThrow("HTTPS")
    expect(() => store.issue({ ...identity, zmxName: "rubato-018f1e2d3c4b; touch /tmp/pwned" })).toThrow("canonical")
    expect(store.consume("not a ticket!", identity)).toBe(false)
  })
})
