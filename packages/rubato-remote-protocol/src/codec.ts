import { MAX_FRAME_BYTES } from "./constants.js"
import type { ActionRequestEnvelope, ClientResumeRequest, EventEnvelope, LiveSessionSummary } from "./types.js"
import type { HubToSurfaceFrame, SnapshotRequiredFrame, SurfaceToHubFrame } from "./surface.js"
import {
  actionRequestSchema,
  clientResumeSchema,
  eventEnvelopeSchema,
  isJsonValue,
  liveSessionSummarySchema,
  ProtocolValidationError,
} from "./validation.js"
import {
  hubToSurfaceFrameSchema,
  snapshotRequiredFrameSchema,
  surfaceToHubFrameSchema,
} from "./wire-validation.js"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

export function encodeJson(value: unknown): Uint8Array {
  if (!isJsonValue(value)) throw validationError("$", "must be a finite, acyclic JSON value")
  const payload = textEncoder.encode(JSON.stringify(value))
  assertPayloadSize(payload.byteLength)
  return payload
}

export function decodeJson(payload: string | Uint8Array): unknown {
  const bytes = typeof payload === "string" ? textEncoder.encode(payload) : payload
  assertPayloadSize(bytes.byteLength)
  try {
    return JSON.parse(typeof payload === "string" ? payload : textDecoder.decode(payload)) as unknown
  } catch {
    throw validationError("$", "must be valid UTF-8 JSON")
  }
}

export function encodeFrame(value: unknown): Uint8Array {
  const payload = encodeJson(value)
  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer, frame.byteOffset, 4).setUint32(0, payload.byteLength, false)
  frame.set(payload, 4)
  return frame
}

export function decodeFrame(frame: Uint8Array): unknown {
  if (frame.byteLength < 4) throw validationError("$", "frame is missing its 4-byte length prefix")
  const declaredLength = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false)
  assertPayloadSize(declaredLength)
  if (frame.byteLength !== declaredLength + 4) throw validationError("$", "frame length does not match its prefix")
  return decodeJson(frame.subarray(4))
}

export function decodeActionRequest(payload: string | Uint8Array): ActionRequestEnvelope {
  return actionRequestSchema.parse(decodeJson(payload))
}

export function decodeEventEnvelope(payload: string | Uint8Array): EventEnvelope {
  return eventEnvelopeSchema.parse(decodeJson(payload))
}

export function decodeClientResumeRequest(payload: string | Uint8Array): ClientResumeRequest {
  return clientResumeSchema.parse(decodeJson(payload))
}

export function decodeLiveSessionSummary(payload: string | Uint8Array): LiveSessionSummary {
  return liveSessionSummarySchema.parse(decodeJson(payload))
}

export function decodeSurfaceToHubFrame(payload: string | Uint8Array): SurfaceToHubFrame {
  return surfaceToHubFrameSchema.parse(decodeJson(payload))
}

export function decodeHubToSurfaceFrame(payload: string | Uint8Array): HubToSurfaceFrame {
  return hubToSurfaceFrameSchema.parse(decodeJson(payload))
}

export function decodeSnapshotRequiredFrame(payload: string | Uint8Array): SnapshotRequiredFrame {
  return snapshotRequiredFrameSchema.parse(decodeJson(payload))
}

/** Incrementally decodes the canonical four-byte big-endian JSON transport. */
export class JsonFrameDecoder {
  #buffer = new Uint8Array(0)

  push(chunk: Uint8Array): readonly unknown[] {
    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength)
    next.set(this.#buffer)
    next.set(chunk, this.#buffer.byteLength)
    this.#buffer = next
    const values: unknown[] = []
    while (this.#buffer.byteLength >= 4) {
      const declaredLength = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(0, false)
      assertPayloadSize(declaredLength)
      if (this.#buffer.byteLength < declaredLength + 4) break
      values.push(decodeFrame(this.#buffer.subarray(0, declaredLength + 4)))
      this.#buffer = this.#buffer.slice(declaredLength + 4)
    }
    return values
  }

  reset(): void {
    this.#buffer = new Uint8Array(0)
  }
}

function assertPayloadSize(byteLength: number): void {
  if (byteLength > MAX_FRAME_BYTES) throw validationError("$", `payload exceeds ${MAX_FRAME_BYTES} bytes`)
}

function validationError(path: string, message: string): ProtocolValidationError {
  return new ProtocolValidationError([{ path, message }])
}
