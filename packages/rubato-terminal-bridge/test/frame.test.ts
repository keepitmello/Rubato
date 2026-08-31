import { describe, expect, test } from "bun:test"
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  MAX_TERMINAL_PAYLOAD_BYTES,
  TerminalFrameDecoder,
  TerminalFrameError,
} from "../src/index.js"

const encoder = new TextEncoder()

describe("terminal binary frames", () => {
  test("round-trips all five frame types with a one-byte type and BE length", () => {
    const frames = [
      { type: "output", data: encoder.encode("hello") },
      { type: "input", data: encoder.encode("안녕") },
      { type: "resize", cols: 132, rows: 43 },
      { type: "exit" },
      { type: "error", message: "failed" },
    ] as const
    for (const frame of frames) {
      const encoded = encodeTerminalFrame(frame)
      expect(encoded.byteLength).toBeGreaterThanOrEqual(5)
      expect(new DataView(encoded.buffer, encoded.byteOffset + 1, 4).getUint32(0, false)).toBe(encoded.byteLength - 5)
      expect(decodeTerminalFrame(encoded)).toEqual(frame)
    }
  })

  test("incrementally decodes split and coalesced frames", () => {
    const first = encodeTerminalFrame({ type: "input", data: encoder.encode("abc") })
    const second = encodeTerminalFrame({ type: "resize", cols: 80, rows: 24 })
    const bytes = new Uint8Array(first.byteLength + second.byteLength)
    bytes.set(first)
    bytes.set(second, first.byteLength)
    const decoder = new TerminalFrameDecoder()
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([])
    expect(decoder.push(bytes.subarray(3))).toEqual([
      { type: "input", data: encoder.encode("abc") },
      { type: "resize", cols: 80, rows: 24 },
    ])
    decoder.finish()
  })

  test("rejects truncation, unknown types, malformed resize/exit, and oversized declarations before allocation", () => {
    expect(() => decodeTerminalFrame(new Uint8Array([2, 0, 0]))).toThrow(TerminalFrameError)
    expect(() => decodeTerminalFrame(new Uint8Array([0xff, 0, 0, 0, 0]))).toThrow("unknown terminal frame type")
    expect(() => decodeTerminalFrame(new Uint8Array([3, 0, 0, 0, 3, 0, 80, 24]))).toThrow("four bytes")
    expect(() => decodeTerminalFrame(new Uint8Array([4, 0, 0, 0, 1, 0]))).toThrow("must be empty")
    const oversized = new Uint8Array([1, 0, 0, 0, 0])
    new DataView(oversized.buffer).setUint32(1, MAX_TERMINAL_PAYLOAD_BYTES + 1, false)
    expect(() => new TerminalFrameDecoder().push(oversized)).toThrow("payload is too large")
    const decoder = new TerminalFrameDecoder()
    decoder.push(encodeTerminalFrame({ type: "input", data: encoder.encode("x") }).subarray(0, 5))
    expect(() => decoder.finish()).toThrow("truncated frame")
  })

  test("enforces terminal dimensions and error UTF-8", () => {
    expect(() => encodeTerminalFrame({ type: "resize", cols: 0, rows: 24 })).toThrow("columns")
    expect(() => encodeTerminalFrame({ type: "resize", cols: 80, rows: 1001 })).toThrow("rows")
    expect(() => decodeTerminalFrame(new Uint8Array([5, 0, 0, 0, 1, 0xff]))).toThrow("valid UTF-8")
  })
})
