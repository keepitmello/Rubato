import { describe, expect, test } from "bun:test"
import { negotiateProtocolVersion, supportedProtocolRange } from "@rubato/remote-protocol"

describe("multi-host protocol negotiation", () => {
  test("accepts N and N-1 and rejects hosts with no common version", () => {
    const local = supportedProtocolRange(7)
    expect(local).toEqual({ min: 6, max: 7 })
    expect(negotiateProtocolVersion(local, { min: 7, max: 8 })).toEqual({ compatible: true, version: 7 })
    expect(negotiateProtocolVersion(local, { min: 5, max: 6 })).toEqual({ compatible: true, version: 6 })
    expect(negotiateProtocolVersion(local, { min: 4, max: 5 })).toEqual({ compatible: false, reason: "protocol_mismatch" })
  })
})
