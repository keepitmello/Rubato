import type {
  LEAD_EXECUTIONS,
  LIVE_LIFECYCLES,
  REMOTE_ACTION_TYPES,
  REMOTE_ERROR_CODES,
  REMOTE_EVENT_TYPES,
  REMOTE_PROTOCOL_NAME,
} from "./constants.js"
import type { HostId, LiveSessionId, RequestId, ZmxName } from "./identifiers.js"

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type LiveLifecycle = (typeof LIVE_LIFECYCLES)[number]
export type LeadExecution = (typeof LEAD_EXECUTIONS)[number]
export type RemoteActionType = (typeof REMOTE_ACTION_TYPES)[number]
export type RemoteEventType = (typeof REMOTE_EVENT_TYPES)[number]
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number]
export type RemoteProtocolName = typeof REMOTE_PROTOCOL_NAME

export interface SessionModelSummary {
  readonly provider?: string
  readonly id?: string
  readonly label: string
  readonly thinkingLevel?: string
}

export interface SessionContextSummary {
  readonly usedPercent?: number
  readonly remainingPercent?: number
  readonly windowTokens?: number
}

export interface SessionCacheSummary {
  readonly policy?: string
  readonly hitPercent?: number
  readonly expiresAt?: string
  readonly expired: boolean
}

export interface LiveSessionSummary {
  readonly schemaVersion: 1
  readonly hostId: HostId
  readonly liveSessionId: LiveSessionId
  readonly zmxName?: ZmxName
  readonly managed: boolean
  readonly pid?: number
  readonly lifecycle: LiveLifecycle
  readonly execution: LeadExecution
  readonly attention: boolean
  readonly title: string
  readonly cwd: string
  readonly createdAt: string
  readonly lastAssistantAt?: string
  readonly pi: {
    readonly sessionId?: string
    readonly sessionFile?: string
    readonly leafId?: string
  }
  readonly model: SessionModelSummary
  readonly context: SessionContextSummary
  readonly cache: SessionCacheSummary
  readonly background: {
    readonly activeCount: number
    readonly labels: readonly string[]
  }
  readonly teams: {
    readonly activeRunCount: number
    readonly runningMemberCount: number
    readonly failedMemberCount: number
  }
  readonly build: {
    readonly rubatoCommit?: string
    readonly piVersion: string
    readonly remoteProtocolMin: number
    readonly remoteProtocolMax: number
  }
  readonly capabilities: readonly string[]
}

export interface RemoteActionPayloadMap {
  readonly "input.submit": {
    readonly text: string
    readonly imageIds?: readonly string[]
    readonly delivery?: "auto"
  }
  readonly "input.steer": {
    readonly text: string
    readonly imageIds?: readonly string[]
  }
  readonly "input.followUp": {
    readonly text: string
    readonly imageIds?: readonly string[]
  }
  readonly "agent.abort": Readonly<Record<string, never>>
  readonly "session.compact": { readonly instructions?: string }
  readonly "session.navigate": {
    readonly targetEntryId: string
    readonly summarize?: boolean
    readonly instructions?: string
  }
  readonly "session.fork": { readonly targetEntryId?: string }
  readonly "session.new": Readonly<Record<string, never>>
  readonly "session.reload": Readonly<Record<string, never>>
  readonly "session.rename": { readonly name: string }
  readonly "model.set": { readonly provider: string; readonly modelId: string }
  readonly "thinking.set": { readonly level: string }
  readonly "bash.execute": { readonly command: string; readonly excludeFromContext: boolean }
  readonly "bash.abort": Readonly<Record<string, never>>
  readonly "ui.respond": { readonly requestId: string; readonly value: JsonValue }
  readonly "environment.refresh": Readonly<Record<string, never>>
}

export type RemoteAction = {
  readonly [Action in RemoteActionType]: Readonly<{ type: Action } & RemoteActionPayloadMap[Action]>
}[RemoteActionType]

interface ActionRequestEnvelopeBase {
  readonly protocol: RemoteProtocolName
  readonly requestId: RequestId
  readonly hostId: HostId
  readonly liveSessionId: LiveSessionId
  readonly expectedRevision?: number
}

export type ActionRequestEnvelope = {
  readonly [Action in RemoteActionType]: ActionRequestEnvelopeBase & {
    readonly action: Action
    readonly payload: RemoteActionPayloadMap[Action]
  }
}[RemoteActionType]

export interface LiveTerminateAction {
  readonly type: "live.terminate"
  readonly liveSessionId: LiveSessionId
  readonly force: boolean
}

export interface EventEnvelope<Payload extends JsonObject = JsonObject> {
  readonly protocol: RemoteProtocolName
  readonly hostId: HostId
  readonly liveSessionId: LiveSessionId
  readonly seq: number
  readonly at: string
  readonly type: RemoteEventType
  readonly payload: Payload
}

export interface ClientResumeRequest {
  readonly type: "client.resume"
  readonly sessions: readonly {
    readonly liveSessionId: LiveSessionId
    readonly lastSeq: number
  }[]
}

export interface RemoteError {
  readonly code: RemoteErrorCode
  readonly message: string
  readonly traceId: string
  readonly details?: JsonObject
}

export interface RemoteErrorResponse {
  readonly error: RemoteError
}
