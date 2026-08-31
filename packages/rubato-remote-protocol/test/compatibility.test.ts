import { describe, expect, test } from "bun:test"
import {
  REMOTE_PROTOCOL_CURRENT_VERSION,
  REMOTE_PROTOCOL_MIN_VERSION,
  SUPPORTED_PROTOCOL_RANGE,
  negotiateProtocolVersion,
  supportedProtocolRange,
  supportsProtocolVersion,
} from "../src/index.js"

describe("N/N-1 protocol compatibility", () => {
  test("advertises the current contract range", () => {
    expect(SUPPORTED_PROTOCOL_RANGE).toEqual({
      min: REMOTE_PROTOCOL_MIN_VERSION,
      max: REMOTE_PROTOCOL_CURRENT_VERSION,
    })
    expect(SUPPORTED_PROTOCOL_RANGE).toEqual(supportedProtocolRange(REMOTE_PROTOCOL_CURRENT_VERSION))
  })

  test("limits every future range to N and N-1", () => {
    expect(supportedProtocolRange(7)).toEqual({ min: 6, max: 7 })
    expect(supportedProtocolRange(1)).toEqual({ min: 1, max: 1 })
  })

  test("negotiates the highest common version", () => {
    expect(negotiateProtocolVersion({ min: 4, max: 5 }, { min: 5, max: 6 })).toEqual({
      compatible: true,
      version: 5,
    })
    expect(supportsProtocolVersion({ min: 4, max: 5 }, 4)).toBe(true)
  })

  test("returns a stable mismatch and rejects invalid ranges", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 2 }, { min: 3, max: 4 })).toEqual({
      compatible: false,
      reason: "protocol_mismatch",
    })
    expect(() => negotiateProtocolVersion({ min: 2, max: 1 }, { min: 1, max: 1 })).toThrow(RangeError)
    expect(() => supportedProtocolRange(0)).toThrow(RangeError)
  })
})
