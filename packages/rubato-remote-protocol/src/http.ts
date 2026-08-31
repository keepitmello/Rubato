import type { ProtocolNegotiationResult, ProtocolVersionRange } from "./compatibility.js"
import type { HostId, LiveSessionId, ZmxName } from "./identifiers.js"
import type { JsonObject, LiveSessionSummary, RequestRunSummary, RequestTimelineSnapshot } from "./types.js"
import type { ConversationEntry, InteractiveCommandDescriptor, SessionTreeEntry, UiRequest } from "./surface.js"

export interface HealthResponse {
  readonly ok: true
  readonly hostId: HostId
}

export interface HostDescriptionResponse {
  readonly hostId: HostId
  readonly displayName: string
  readonly ownerLogin: string
  readonly protocol: ProtocolVersionRange
  readonly negotiation: ProtocolNegotiationResult
  readonly capabilities: readonly string[]
  readonly pushPublicKey: string
}

export interface RegisteredHost {
  readonly hostId: HostId
  readonly displayName: string
  readonly baseUrl: string
  readonly ownerLogin: string
  readonly pairedAt: string
  readonly lastSeenAt?: string
  readonly protocolMin?: number
  readonly protocolMax?: number
}

export type HostConnectionState = "online" | "connecting" | "offline" | "incompatible" | "denied"

export interface HostInventory {
  readonly host: RegisteredHost
  readonly sessions: readonly LiveSessionSummary[]
  readonly connection: HostConnectionState
  readonly problem?: string
}

export interface HostInventoryResponse {
  readonly hostSeq: number
  readonly sessions: readonly LiveSessionSummary[]
}

export interface PairingQrPayload {
  readonly type: "rubato-host-pair"
  readonly baseUrl: string
  readonly hostId: HostId
  readonly nonce: string
  readonly expiresAt: string
}

export interface PairClaimRequest {
  readonly nonce: string
}

export interface PairClaimResponse {
  readonly claimId: string
  readonly expiresAt: string
}

export interface PairApproveRequest {
  readonly claimId: string
  readonly confirmed: true
}

export interface PairApproveResponse {
  readonly paired: true
  readonly origin: string
}

export interface WebSocketTicketRequest {
  readonly purpose: "events"
}

export interface TerminalTicketRequest {
  readonly purpose: "terminal"
}

export interface TicketResponse {
  readonly ticket: string
  readonly expiresAt: string
}

export interface CreateLiveSessionRequest {
  readonly cwd: string
  readonly name?: string
  readonly initialPrompt?: string
  readonly model?: { readonly provider: string; readonly modelId: string }
  readonly thinkingLevel?: string
  readonly attachAfterCreate: boolean
  readonly rubatoArgs?: readonly string[]
}

export interface CreateLiveSessionResponse {
  readonly liveSessionId: LiveSessionId
  readonly zmxName: ZmxName
}

export interface TerminateLiveSessionRequest {
  readonly force?: boolean
}

export interface TerminateLiveSessionResponse {
  readonly terminated: true
}

export interface ActionResultResponse {
  readonly accepted: boolean
  readonly revision: number
  readonly payload: JsonObject
}

export interface MessagePageRequest {
  readonly before?: string
  readonly limit?: number
}

export interface MessagePageResponse {
  readonly entries: readonly ConversationEntry[]
  readonly requestRuns?: readonly RequestRunSummary[]
  readonly nextBefore?: string
}

export interface ImageUploadRequest {
  readonly fileName: string
  readonly mimeType: string
  readonly dataBase64: string
}

export interface ImageUploadResponse {
  readonly imageId: string
  readonly mimeType: string
  readonly byteLength: number
}

export interface ArtifactRequest {
  readonly artifactId: string
}

export interface ArtifactResponse {
  readonly artifactId: string
  readonly contentType: string
  readonly encoding: "utf8" | "base64"
  readonly content: string
  readonly byteLength: number
  readonly truncated: boolean
}

export interface FileReadRequest {
  readonly path: string
  readonly maxBytes?: number
}

export interface FileReadResponse {
  readonly path: string
  readonly content: string
  readonly encoding: "utf8" | "base64"
  readonly byteLength: number
  readonly truncated: boolean
  readonly language?: string
}

export interface GitStatusEntry {
  readonly path: string
  readonly status: string
}

export interface GitStatusResponse {
  readonly files: readonly GitStatusEntry[]
}

export interface GitDiffFile {
  readonly fileName: string
  readonly fileLang: string
  readonly content: string
}

export interface GitDiff {
  readonly oldFile: GitDiffFile
  readonly newFile: GitDiffFile
  readonly hunks: readonly string[]
}

export interface GitDiffRequest {
  readonly path?: string
  readonly contextLines?: number
}

export interface GitDiffResponse {
  readonly diff: GitDiff
  readonly summary: string
}

export type ProjectChoiceSource = "recent" | "favorite" | "browse"

export interface ProjectChoice {
  readonly path: string
  readonly label: string
  readonly source: ProjectChoiceSource
}

export interface ProjectListResponse {
  readonly projects: readonly ProjectChoice[]
}

export interface ProjectFavoritesUpdateRequest {
  readonly paths: readonly string[]
}

export interface ProjectFavoritesUpdateResponse {
  readonly projects: readonly ProjectChoice[]
}

export interface ProjectBrowseRequest {
  readonly path?: string
  readonly showHidden?: boolean
  readonly cursor?: string
  readonly limit?: number
}

export interface ProjectBrowseEntry {
  readonly name: string
  readonly path: string
  readonly symlink: boolean
}

export interface ProjectBrowseResponse {
  readonly path: string
  readonly parentPath?: string
  readonly directories: readonly ProjectBrowseEntry[]
  readonly nextCursor?: string
}

export interface PushSubscription {
  readonly endpoint: string
  readonly expirationTime?: number | null | undefined
  readonly keys: {
    readonly auth: string
    readonly p256dh: string
  }
}

export interface PushSubscribeRequest {
  readonly subscription: PushSubscription
}

export interface PushSubscribeResponse {
  readonly vapidPublicKey: string
  readonly createdAt: string
}

export interface PushProfileExportRequest {
  readonly destinationPublicKey: string
}

export interface EncryptedPushProfile {
  readonly schemaVersion: 1
  readonly ephemeralPublicKey: string
  readonly salt: string
  readonly nonce: string
  readonly tag: string
  readonly ciphertext: string
}

export type PushProfileImportRequest = EncryptedPushProfile

export interface PushProfileImportResponse {
  readonly imported: true
  readonly pwaOrigin: string
}

export interface PushRotateResponse {
  readonly requiresResubscribe: true
  readonly vapidPublicKey: string
}

export interface PushEnvelope {
  readonly type: "session-settled" | "attention-required" | "session-error" | "team-failed"
  readonly hostId: HostId
  readonly liveSessionId: LiveSessionId
  readonly title: string
  readonly body: string
  readonly url: string
}

export interface SnapshotResponse {
  readonly summary: LiveSessionSummary
  readonly revision: number
  readonly lastSeq: number
  readonly entries: readonly ConversationEntry[]
  readonly tree: readonly SessionTreeEntry[]
  readonly commands: readonly InteractiveCommandDescriptor[]
  readonly uiRequest?: UiRequest | undefined
  readonly timeline?: RequestTimelineSnapshot
}
