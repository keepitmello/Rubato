import { describe, expect, test } from "bun:test"
import { negotiateProtocolVersion, supportedProtocolRange } from "@rubato/remote-protocol"
import { isOwner, normalizeLogin, TailscaleServeIdentityVerifier } from "../src/identity.js"

describe("multi-host protocol negotiation", () => {
  test("accepts N and N-1 and rejects hosts with no common version", () => {
    const local = supportedProtocolRange(7)
    expect(local).toEqual({ min: 6, max: 7 })
    expect(negotiateProtocolVersion(local, { min: 7, max: 8 })).toEqual({ compatible: true, version: 7 })
    expect(negotiateProtocolVersion(local, { min: 5, max: 6 })).toEqual({ compatible: true, version: 6 })
    expect(negotiateProtocolVersion(local, { min: 4, max: 5 })).toEqual({ compatible: false, reason: "protocol_mismatch" })
  })
})

describe("Tailscale Serve identity enforcement", () => {
  test("rejects spoofed identity headers unless the backend connection is loopback", async () => {
    const verifier = new TailscaleServeIdentityVerifier()
    const headers = new Headers({
      "tailscale-user-login": "Owner@Example.COM ",
      "tailscale-user-name": "=?UTF-8?B?7ZmN6ri464+Z?=",
    })
    expect(await verifier.verify({ remoteAddress: "192.168.1.4", headers })).toBeNull()
    const identity = await verifier.verify({ remoteAddress: "127.0.0.1", headers })
    expect(identity).toEqual({ login: "owner@example.com", name: "홍길동" })
    expect(isOwner(identity, "OWNER@example.com")).toBeTrue()
  })

  test("does not derive identity from forwarded or arbitrary user headers", async () => {
    const verifier = new TailscaleServeIdentityVerifier()
    const headers = new Headers({ "x-forwarded-for": "127.0.0.1", "x-user": "owner@example.com" })
    expect(await verifier.verify({ remoteAddress: "127.0.0.1", headers })).toBeNull()
    expect(normalizeLogin("  User@Example.COM ")).toBe("user@example.com")
  })
})
