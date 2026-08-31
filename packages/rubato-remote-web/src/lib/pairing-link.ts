import { pairingQrPayloadSchema, type PairingQrPayload } from "@rubato/remote-protocol"

export function hasPairingLink(search: string): boolean {
  return new URLSearchParams(search).has("pair")
}

export function parsePairingLink(search: string): PairingQrPayload | null {
  const encoded = new URLSearchParams(search).get("pair")
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    return pairingQrPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return null
  }
}
