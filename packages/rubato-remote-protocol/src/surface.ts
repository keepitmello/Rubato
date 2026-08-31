import type { ProtocolNegotiationResult, ProtocolVersionRange } from "./compatibility.js"
import type { RemoteProtocolName } from "./types.js"
import type {
  ActionRequestEnvelope,
  JsonObject,
  LiveSessionSummary,
  RemoteEventType,
} from "./types.js"
import type { HostId, LiveSessionId, RequestId, SurfaceInstanceId, ZmxName } from "./identifiers.js"

export interface SurfaceRegisterFrame {
  readonly kind: "surface.register"
  readonly protocol: RemoteProtocolName
  readonly protocolRange: ProtocolVersionRange
  readonly surfaceInstanceId: SurfaceInstanceId
  readonly token?: string
  readonly reconnectToken?: string
  readonly summary: LiveSessionSummary
}

export interface SurfaceHeartbeatFrame {
  readonly kind: "surface.heartbeat"
  readonly protocol: RemoteProtocolName
  readonly surfaceInstanceId: SurfaceInstanceId
  readonly sourceSeq: number
  readonly at: string
}

export interface SurfaceEventFrame {
  readonly kind: "surface.event"
  readonly protocol: RemoteProtocolName
  readonly liveSessionId: LiveSessionId
  readonly surfaceInstanceId: SurfaceInstanceId
  readonly sourceSeq: number
  readonly at: string
  readonly type: RemoteEventType
  readonly payload: JsonObject
}

export interface SurfaceSnapshotFrame {
  readonly kind: "surface.snapshot"
  readonly protocol: RemoteProtocolName
  readonly surfaceInstanceId: SurfaceInstanceId
  readonly sourceSeq: number
  readonly at: string
  readonly summary: LiveSessionSummary
  readonly state: SessionSnapshotState
}

export interface SurfaceActionResultFrame {
  readonly kind: "surface.action-result"
  readonly protocol: RemoteProtocolName
  readonly requestId: RequestId
  readonly accepted: boolean
  readonly revision: number
  readonly payload: JsonObject
}

export interface BootstrapClaimFrame {
  readonly kind: "bootstrap.claim"
  readonly protocol: RemoteProtocolName
  readonly token: string
}

export interface BootstrapLaunchPayload {
  readonly schemaVersion: 1
  readonly liveSessionId: LiveSessionId
  readonly hostId: HostId
  readonly zmxName: ZmxName
  readonly labels: Readonly<Record<string, string>>
  readonly cwd: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly launcherPath: string
  readonly zmxBinary: string
  readonly hubSocket: string
  readonly surfaceToken: string
}

export interface HubLaunchFrame {
  readonly kind: "hub.launch"
  readonly protocol: RemoteProtocolName
  readonly launch: BootstrapLaunchPayload
}

export interface HubRegisteredFrame {
  readonly kind: "hub.registered"
  readonly protocol: RemoteProtocolName
  readonly hostSeq: number
  readonly reconnectToken: string
  readonly protocolRange: ProtocolVersionRange
  readonly negotiation: ProtocolNegotiationResult
}

export interface HubActionFrame {
  readonly kind: "hub.action"
  readonly protocol: RemoteProtocolName
  readonly request: ActionRequestEnvelope
}

export type SurfaceToHubFrame =
  | BootstrapClaimFrame
  | SurfaceRegisterFrame
  | SurfaceHeartbeatFrame
  | SurfaceEventFrame
  | SurfaceSnapshotFrame
  | SurfaceActionResultFrame

export type HubToSurfaceFrame = HubLaunchFrame | HubRegisteredFrame | HubActionFrame

export interface SurfaceReconnectCredentialPayload {
  readonly schemaVersion: 1
  readonly liveSessionId: LiveSessionId
  readonly surfaceInstanceId: SurfaceInstanceId
  readonly expiresAt: number
  readonly nonce: string
}

export type ConversationEntry = JsonObject & (
  | {
      readonly id: string
      readonly kind: "message"
      readonly role: "user" | "assistant"
      readonly text: string
      readonly streaming?: boolean
      readonly at?: string
    }
  | {
      readonly id: string
      readonly kind: "thinking"
      readonly text: string
      readonly streaming?: boolean
    }
  | {
      readonly id: string
      readonly kind: "tool"
      readonly name: string
      readonly summary: string
      readonly status: "running" | "done" | "failed"
      readonly output?: string
      readonly artifactId?: string
    }
  | { readonly id: string; readonly kind: "image"; readonly alt: string; readonly url: string }
  | { readonly id: string; readonly kind: "notice"; readonly text: string }
)

export interface SessionTreeEntry extends JsonObject {
  readonly id: string
  readonly label: string
  readonly current: boolean
}

export interface UiOption extends JsonObject {
  readonly label: string
  readonly value: string
}

export interface UiRequest {
  readonly requestId: string
  readonly kind: "select" | "confirm" | "input"
  readonly title: string
  readonly message?: string | undefined
  readonly options?: readonly UiOption[] | undefined
  readonly placeholder?: string | undefined
}

export interface InteractiveCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly category: "builtin" | "extension" | "skill" | "template"
  readonly remoteMode: "direct" | "native-action" | "terminal-only"
}

export interface SessionSnapshotState {
  readonly revision: number
  readonly entries: readonly ConversationEntry[]
  readonly tree: readonly SessionTreeEntry[]
  readonly commands: readonly InteractiveCommandDescriptor[]
  readonly streamingMessage?: JsonObject | undefined
  readonly activeTools?: readonly JsonObject[] | undefined
  readonly uiRequest?: UiRequest | undefined
  readonly background?: JsonObject | undefined
  readonly teams?: JsonObject | undefined
  readonly capabilities: readonly string[]
}

export interface SessionSnapshot {
  readonly schemaVersion: 1
  readonly liveSessionId: LiveSessionId
  readonly lastSeq: number
  readonly writtenAt: string
  readonly summary: LiveSessionSummary
  readonly state: SessionSnapshotState
}

export interface SnapshotRequiredFrame {
  readonly type: "snapshot.required"
  readonly protocol: RemoteProtocolName
  readonly liveSessionId: LiveSessionId
  readonly snapshot?: SessionSnapshot
}
