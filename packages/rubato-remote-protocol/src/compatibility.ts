import { REMOTE_PROTOCOL_CURRENT_VERSION, REMOTE_PROTOCOL_MIN_VERSION } from "./constants.js"

export interface ProtocolVersionRange {
  readonly min: number
  readonly max: number
}

export type ProtocolNegotiationResult =
  | { readonly compatible: true; readonly version: number }
  | { readonly compatible: false; readonly reason: "protocol_mismatch" }

export const SUPPORTED_PROTOCOL_RANGE: ProtocolVersionRange = Object.freeze({
  min: REMOTE_PROTOCOL_MIN_VERSION,
  max: REMOTE_PROTOCOL_CURRENT_VERSION,
})

export function supportedProtocolRange(currentVersion: number): ProtocolVersionRange {
  assertProtocolVersion(currentVersion, "currentVersion")
  return { min: Math.max(1, currentVersion - 1), max: currentVersion }
}

export function negotiateProtocolVersion(
  local: ProtocolVersionRange,
  remote: ProtocolVersionRange,
): ProtocolNegotiationResult {
  assertProtocolRange(local, "local")
  assertProtocolRange(remote, "remote")
  const version = Math.min(local.max, remote.max)
  if (version < Math.max(local.min, remote.min)) return { compatible: false, reason: "protocol_mismatch" }
  return { compatible: true, version }
}

export function supportsProtocolVersion(range: ProtocolVersionRange, version: number): boolean {
  assertProtocolRange(range, "range")
  assertProtocolVersion(version, "version")
  return version >= range.min && version <= range.max
}

function assertProtocolRange(range: ProtocolVersionRange, name: string): void {
  assertProtocolVersion(range.min, `${name}.min`)
  assertProtocolVersion(range.max, `${name}.max`)
  if (range.min > range.max) throw new RangeError(`${name}.min must not exceed ${name}.max`)
}

function assertProtocolVersion(version: number, name: string): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError(`${name} must be a positive integer`)
}
