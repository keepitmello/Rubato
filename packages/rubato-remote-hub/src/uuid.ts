import { randomBytes } from "node:crypto"
import type { LiveSessionId } from "@rubato/remote-protocol"

let lastTimestamp = 0
let sequence = 0

export function uuidV7(now = Date.now()): LiveSessionId {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError("invalid UUIDv7 timestamp")
  if (now === lastTimestamp) sequence = (sequence + 1) & 0xfff
  else {
    lastTimestamp = now
    sequence = randomBytes(2).readUInt16BE() & 0xfff
  }
  const bytes = randomBytes(16)
  bytes[0] = (now / 0x10000000000) & 0xff
  bytes[1] = (now / 0x100000000) & 0xff
  bytes[2] = (now / 0x1000000) & 0xff
  bytes[3] = (now / 0x10000) & 0xff
  bytes[4] = (now / 0x100) & 0xff
  bytes[5] = now & 0xff
  bytes[6] = 0x70 | ((sequence >>> 8) & 0x0f)
  bytes[7] = sequence & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
