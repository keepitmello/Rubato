import type { HostId } from "./identifiers.js"
import type { JsonObject } from "./types.js"

export interface PairingQrPayload {
  readonly type: "rubato-host-pair"
  readonly baseUrl: string
  readonly hostId: HostId
  readonly nonce: string
  readonly expiresAt: string
}

export interface ActionResultResponse {
  readonly accepted: boolean
  readonly revision: number
  readonly payload: JsonObject
}
