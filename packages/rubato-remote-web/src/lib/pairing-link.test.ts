import { describe, expect, it } from "vitest"
import { hasPairingLink, parsePairingLink } from "./pairing-link"

const payload = {
  type: "rubato-host-pair",
  baseUrl: "https://my-mac.example.ts.net/rubato/",
  hostId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: "2026-08-31T01:00:00.000Z",
}

const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

describe("pairing links", () => {
  it("decodes and validates the one-time payload produced by the hub", () => {
    const search = `?pair=${encode(payload)}`
    expect(hasPairingLink(search)).toBe(true)
    expect(parsePairingLink(search)).toEqual(payload)
  })

  it("rejects malformed, non-HTTPS, and wrong-purpose payloads", () => {
    expect(parsePairingLink("?pair=not*base64")).toBeNull()
    expect(parsePairingLink(`?pair=${encode({ ...payload, baseUrl: "http://example.com/rubato/" })}`)).toBeNull()
    expect(parsePairingLink(`?pair=${encode({ ...payload, type: "other" })}`)).toBeNull()
  })
})
