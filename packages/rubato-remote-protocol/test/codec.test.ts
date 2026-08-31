import { describe, expect, test } from "bun:test"
import {
  JsonFrameDecoder,
  MAX_FRAME_BYTES,
  ProtocolValidationError,
  decodeActionRequest,
  decodeFrame,
  decodeJson,
  decodeSurfaceToHubFrame,
  encodeFrame,
} from "../src/index.js"

const fixtureUrl = new URL("./fixtures/action-request.v1.json", import.meta.url)
const surfaceFixtureUrl = new URL("./fixtures/surface-register.v1.json", import.meta.url)

describe("protocol codec", () => {
  test("round-trips a length-prefixed UTF-8 JSON frame", async () => {
    const action = await Bun.file(fixtureUrl).json()
    const frame = encodeFrame(action)

    expect(new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false)).toBe(frame.byteLength - 4)
    expect(decodeFrame(frame)).toEqual(action)
  })

  test("decodes and validates an action fixture", async () => {
    const source = await Bun.file(fixtureUrl).text()
    expect(decodeActionRequest(source).action).toBe("input.submit")
  })

  test("incrementally decodes canonical surface frames across arbitrary chunk boundaries", async () => {
    const registration = await Bun.file(surfaceFixtureUrl).json()
    const heartbeat = {
      kind: "surface.heartbeat",
      protocol: "rubato.remote.v1",
      surfaceInstanceId: "123e4567-e89b-42d3-a456-426614174000",
      sourceSeq: 0,
      at: "2026-08-31T01:00:00.000Z",
    }
    const first = encodeFrame(registration)
    const second = encodeFrame(heartbeat)
    const joined = new Uint8Array(first.byteLength + second.byteLength)
    joined.set(first)
    joined.set(second, first.byteLength)
    const decoder = new JsonFrameDecoder()
    expect(decoder.push(joined.subarray(0, 3))).toEqual([])
    expect(decoder.push(joined.subarray(3, first.byteLength + 2))).toEqual([registration])
    expect(decoder.push(joined.subarray(first.byteLength + 2))).toEqual([heartbeat])
    expect(decodeSurfaceToHubFrame(await Bun.file(surfaceFixtureUrl).text()).kind).toBe("surface.register")
  })

  test("rejects malformed JSON and invalid UTF-8", () => {
    expect(() => decodeJson("{")) .toThrow(ProtocolValidationError)
    expect(() => decodeJson(Uint8Array.of(0xff))).toThrow(ProtocolValidationError)
  })

  test("rejects truncated, trailing, and oversized frames", () => {
    expect(() => decodeFrame(Uint8Array.of(0, 0, 0))).toThrow("length prefix")
    expect(() => decodeFrame(Uint8Array.of(0, 0, 0, 2, 0x7b))).toThrow("does not match")
    expect(() => decodeFrame(Uint8Array.of(0, 0, 0, 0, 0))).toThrow("does not match")

    const oversizedHeader = new Uint8Array(4)
    new DataView(oversizedHeader.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)
    expect(() => decodeFrame(oversizedHeader)).toThrow(`exceeds ${MAX_FRAME_BYTES}`)
  })
})
