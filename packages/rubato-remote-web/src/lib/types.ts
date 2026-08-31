import type {
  ConversationEntry,
  EventEnvelope,
  HostInventory,
  LeadExecution,
  ProjectChoice,
  RegisteredHost,
  RequestTimelineSnapshot,
  SnapshotResponse,
  UiRequest,
} from "@rubato/remote-protocol"

export type { ConversationEntry, HostInventory, ProjectChoice, RegisteredHost, UiRequest }
export type SessionSnapshot = SnapshotResponse

export interface ConversationState {
  entries: readonly ConversationEntry[]
  lastSeq: number
  requiresSnapshot: boolean
  snapshotInstalled: boolean
  recoveryVersion: number
  bufferedEvents: readonly EventEnvelope[]
  uiRequest?: UiRequest | undefined
  timeline?: RequestTimelineSnapshot | undefined
  execution?: LeadExecution | undefined
}

export interface ImageAttachment {
  imageId: string
  name: string
  previewUrl: string
}

export type RemoteEvent = EventEnvelope
