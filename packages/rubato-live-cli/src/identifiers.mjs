import { randomBytes } from "node:crypto";
import {
  isUuidV7,
  isZmxName,
  zmxNameForLiveSession,
} from "../../rubato-remote-protocol/src/identifiers.ts";

export { isUuidV7, isZmxName, zmxNameForLiveSession };

// @rubato/remote-protocol currently validates but does not allocate UUIDv7 values.
// Keep allocation at this boundary and immediately validate with the shared contract.
export function createUuidV7(now = Date.now(), random = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError("UUIDv7 timestamp is out of range");
  if (!(random instanceof Uint8Array) || random.length < 10) throw new TypeError("UUIDv7 requires 10 random bytes");
  const bytes = new Uint8Array(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = Buffer.from(bytes).toString("hex");
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!isUuidV7(value)) throw new Error("generated identifier violates @rubato/remote-protocol");
  return value;
}
