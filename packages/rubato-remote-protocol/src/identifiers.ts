export type HostId = string
export type LiveSessionId = string
export type PiSessionId = string
export type SessionFile = string
export type LeafId = string
export type SurfaceInstanceId = string
export type ClientId = string
export type RequestId = string
export type ZmxName = string

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ZMX_NAME_PATTERN = /^rubato-[0-9a-f]{12}$/

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value)
}

export function isZmxName(value: unknown): value is ZmxName {
  return typeof value === "string" && ZMX_NAME_PATTERN.test(value)
}

export function zmxNameForLiveSession(liveSessionId: LiveSessionId): ZmxName {
  if (!isUuidV7(liveSessionId)) throw new TypeError("liveSessionId must be a UUIDv7")
  return `rubato-${liveSessionId.replaceAll("-", "").slice(0, 12)}`
}
