import { pairingQrPayloadSchema, type PairingQrPayload } from "@rubato/remote-protocol"

export function hasPairingLink(search: string): boolean {
  return new URLSearchParams(search).has("pair")
}

function parseEncodedPayload(encoded: string | null): PairingQrPayload | null {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    return pairingQrPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return null
  }
}

export function parsePairingLink(search: string): PairingQrPayload | null {
  return parseEncodedPayload(new URLSearchParams(search).get("pair"))
}

export function parsePairingQrText(text: string): PairingQrPayload | null {
  const value = text.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:") return null
    return parsePairingLink(url.search)
  } catch {
    try {
      return pairingQrPayloadSchema.parse(JSON.parse(value))
    } catch {
      return null
    }
  }
}

export function pairingPayloadExpired(payload: PairingQrPayload, now = Date.now()): boolean {
  return Date.parse(payload.expiresAt) <= now
}
