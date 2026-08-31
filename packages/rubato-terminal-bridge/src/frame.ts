export const TERMINAL_FRAME_HEADER_BYTES = 5
export const MAX_TERMINAL_PAYLOAD_BYTES = 256 * 1024
export const MAX_TERMINAL_ERROR_BYTES = 16 * 1024
export const MIN_TERMINAL_COLUMNS = 1
export const MAX_TERMINAL_COLUMNS = 1_000
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_ROWS = 1_000

export const TERMINAL_FRAME_TYPES = Object.freeze({
  output: 0x01,
  input: 0x02,
  resize: 0x03,
  exit: 0x04,
  error: 0x05,
} as const)

export type TerminalFrame =
  | { readonly type: "output"; readonly data: Uint8Array }
  | { readonly type: "input"; readonly data: Uint8Array }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "exit" }
  | { readonly type: "error"; readonly message: string }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

export class TerminalFrameError extends Error {
  override readonly name = "TerminalFrameError"
}

export function encodeTerminalFrame(frame: TerminalFrame): Uint8Array {
  switch (frame.type) {
    case "output":
      return encodeRaw(TERMINAL_FRAME_TYPES.output, frame.data)
    case "input":
      return encodeRaw(TERMINAL_FRAME_TYPES.input, frame.data)
    case "resize": {
      assertTerminalSize(frame.cols, frame.rows)
      const payload = new Uint8Array(4)
      const view = new DataView(payload.buffer)
      view.setUint16(0, frame.cols, false)
      view.setUint16(2, frame.rows, false)
      return encodeRaw(TERMINAL_FRAME_TYPES.resize, payload)
    }
    case "exit":
      return encodeRaw(TERMINAL_FRAME_TYPES.exit, new Uint8Array(0))
    case "error": {
      const payload = textEncoder.encode(frame.message)
      if (payload.byteLength > MAX_TERMINAL_ERROR_BYTES) throw new TerminalFrameError("terminal error payload is too large")
      return encodeRaw(TERMINAL_FRAME_TYPES.error, payload)
    }
  }
}

export function decodeTerminalFrame(frame: Uint8Array): TerminalFrame {
  if (frame.byteLength < TERMINAL_FRAME_HEADER_BYTES) throw new TerminalFrameError("terminal frame is truncated")
  const type = frame[0]!
  assertKnownType(type)
  const length = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, false)
  assertPayloadLength(type, length)
  if (frame.byteLength !== TERMINAL_FRAME_HEADER_BYTES + length) throw new TerminalFrameError("terminal frame length does not match its header")
  return decodePayload(type, frame.subarray(TERMINAL_FRAME_HEADER_BYTES))
}

export class TerminalFrameDecoder {
  #buffer = new Uint8Array(0)

  push(chunk: Uint8Array): readonly TerminalFrame[] {
    if (chunk.byteLength === 0) return []
    if (this.#buffer.byteLength + chunk.byteLength > TERMINAL_FRAME_HEADER_BYTES + MAX_TERMINAL_PAYLOAD_BYTES) {
      throw new TerminalFrameError("terminal frame buffer is too large")
    }
    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength)
    combined.set(this.#buffer)
    combined.set(chunk, this.#buffer.byteLength)
    this.#buffer = combined

    const frames: TerminalFrame[] = []
    let offset = 0
    while (this.#buffer.byteLength - offset >= TERMINAL_FRAME_HEADER_BYTES) {
      const type = this.#buffer[offset]!
      assertKnownType(type)
      const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset + 1, 4).getUint32(0, false)
      assertPayloadLength(type, length)
      const end = offset + TERMINAL_FRAME_HEADER_BYTES + length
      if (end > this.#buffer.byteLength) break
      frames.push(decodePayload(type, this.#buffer.subarray(offset + TERMINAL_FRAME_HEADER_BYTES, end)))
      offset = end
    }
    this.#buffer = this.#buffer.slice(offset)
    return frames
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) throw new TerminalFrameError("terminal frame stream ended with a truncated frame")
  }

  reset(): void {
    this.#buffer = new Uint8Array(0)
  }
}

export function assertTerminalSize(cols: number, rows: number): void {
  if (!Number.isSafeInteger(cols) || cols < MIN_TERMINAL_COLUMNS || cols > MAX_TERMINAL_COLUMNS) {
    throw new TerminalFrameError(`terminal columns must be between ${MIN_TERMINAL_COLUMNS} and ${MAX_TERMINAL_COLUMNS}`)
  }
  if (!Number.isSafeInteger(rows) || rows < MIN_TERMINAL_ROWS || rows > MAX_TERMINAL_ROWS) {
    throw new TerminalFrameError(`terminal rows must be between ${MIN_TERMINAL_ROWS} and ${MAX_TERMINAL_ROWS}`)
  }
}

function encodeRaw(type: number, payload: Uint8Array): Uint8Array {
  assertPayloadLength(type, payload.byteLength)
  const frame = new Uint8Array(TERMINAL_FRAME_HEADER_BYTES + payload.byteLength)
  frame[0] = type
  new DataView(frame.buffer).setUint32(1, payload.byteLength, false)
  frame.set(payload, TERMINAL_FRAME_HEADER_BYTES)
  return frame
}

function decodePayload(type: number, payload: Uint8Array): TerminalFrame {
  switch (type) {
    case TERMINAL_FRAME_TYPES.output:
      return { type: "output", data: payload.slice() }
    case TERMINAL_FRAME_TYPES.input:
      return { type: "input", data: payload.slice() }
    case TERMINAL_FRAME_TYPES.resize: {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      const cols = view.getUint16(0, false)
      const rows = view.getUint16(2, false)
      assertTerminalSize(cols, rows)
      return { type: "resize", cols, rows }
    }
    case TERMINAL_FRAME_TYPES.exit:
      return { type: "exit" }
    case TERMINAL_FRAME_TYPES.error:
      try {
        return { type: "error", message: textDecoder.decode(payload) }
      } catch {
        throw new TerminalFrameError("terminal error frame must contain valid UTF-8")
      }
    default:
      throw new TerminalFrameError("unknown terminal frame type")
  }
}

function assertKnownType(type: number): void {
  if (type < TERMINAL_FRAME_TYPES.output || type > TERMINAL_FRAME_TYPES.error) throw new TerminalFrameError("unknown terminal frame type")
}

function assertPayloadLength(type: number, length: number): void {
  if (length > MAX_TERMINAL_PAYLOAD_BYTES) throw new TerminalFrameError("terminal frame payload is too large")
  if (type === TERMINAL_FRAME_TYPES.resize && length !== 4) throw new TerminalFrameError("terminal resize payload must be four bytes")
  if (type === TERMINAL_FRAME_TYPES.exit && length !== 0) throw new TerminalFrameError("terminal exit payload must be empty")
  if (type === TERMINAL_FRAME_TYPES.error && length > MAX_TERMINAL_ERROR_BYTES) throw new TerminalFrameError("terminal error payload is too large")
}
