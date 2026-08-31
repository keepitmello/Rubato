import { describe, expect, it } from "vitest"
import { hasPairingLink, pairingPayloadExpired, parsePairingLink, parsePairingQrText } from "./pairing-link"

const payload = {
  type: "rubato-host-pair",
  baseUrl: "https://my-mac.example.ts.net/rubato/",
  hostId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: "2026-08-31T01:00:00.000Z",
} as const

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

  it("reads the full HTTPS URL emitted into the Mac QR", () => {
    const url = `https://my-mac.example.ts.net/rubato/?pair=${encode(payload)}`
    expect(parsePairingQrText(url)).toEqual(payload)
    expect(parsePairingQrText(JSON.stringify(payload))).toEqual(payload)
    expect(parsePairingQrText(`http://my-mac.example/rubato/?pair=${encode(payload)}`)).toBeNull()
  })

  it("reports an expired one-time QR before pairing", () => {
    expect(pairingPayloadExpired(payload, Date.parse("2026-08-31T00:59:59.000Z"))).toBe(false)
    expect(pairingPayloadExpired(payload, Date.parse("2026-08-31T01:00:00.000Z"))).toBe(true)
  })
})
