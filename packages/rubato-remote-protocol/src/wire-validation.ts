import {
  REMOTE_EVENT_TYPES,
  REMOTE_PROTOCOL_NAME,
} from "./constants.js"
import { isUuid, isUuidV7, isZmxName } from "./identifiers.js"
import type {
  ActionResultResponse,
  ArtifactRequest,
  ArtifactResponse,
  CreateLiveSessionRequest,
  CreateLiveSessionResponse,
  EncryptedPushProfile,
  FileReadRequest,
  FileReadResponse,
  GitDiffRequest,
  GitDiffResponse,
  GitStatusResponse,
  HealthResponse,
  HostDescriptionResponse,
  HostInventory,
  HostInventoryResponse,
  ImageUploadRequest,
  ImageUploadResponse,
  MessagePageRequest,
  MessagePageResponse,
  PairApproveRequest,
  PairApproveResponse,
  PairClaimRequest,
  PairClaimResponse,
  PairingQrPayload,
  ProjectBrowseRequest,
  ProjectBrowseResponse,
  ProjectFavoritesUpdateRequest,
  ProjectFavoritesUpdateResponse,
  ProjectListResponse,
  PushEnvelope,
  PushProfileExportRequest,
  PushProfileImportResponse,
  PushRotateResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
  RegisteredHost,
  SnapshotResponse,
  TerminateLiveSessionRequest,
  TerminateLiveSessionResponse,
  TicketResponse,
  WebSocketTicketRequest,
  TerminalTicketRequest,
} from "./http.js"
import type {
  BootstrapClaimFrame,
  BootstrapLaunchPayload,
  HubActionFrame,
  HubLaunchFrame,
  HubRegisteredFrame,
  HubToSurfaceFrame,
  SessionSnapshot,
  SessionSnapshotState,
  SnapshotRequiredFrame,
  SurfaceActionResultFrame,
  SurfaceEventFrame,
  SurfaceHeartbeatFrame,
  SurfaceReconnectCredentialPayload,
  SurfaceRegisterFrame,
  SurfaceSnapshotFrame,
  SurfaceSummaryFrame,
  SurfaceToHubFrame,
} from "./surface.js"
import type { JsonObject } from "./types.js"
import {
  actionRequestSchema,
  isJsonValue,
  liveSessionSummarySchema,
  requestRunSummarySchema,
  requestTimelineSnapshotSchema,
  ProtocolValidationError,
  type ProtocolSchema,
  type ValidationIssue,
  type ValidationResult,
} from "./validation.js"

type Checker = (value: unknown, path: string, issues: ValidationIssue[]) => void

type Shape = Readonly<Record<string, Checker>>

const stringCheck: Checker = (value, path, issues) => {
  if (typeof value !== "string") add(issues, path, "must be a string")
}
const nonEmptyString: Checker = (value, path, issues) => {
  if (typeof value !== "string" || value.length === 0) add(issues, path, "must be a non-empty string")
}
const booleanCheck: Checker = (value, path, issues) => {
  if (typeof value !== "boolean") add(issues, path, "must be a boolean")
}
const nonNegativeInteger: Checker = (value, path, issues) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) add(issues, path, "must be a non-negative integer")
}
const positiveInteger: Checker = (value, path, issues) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) add(issues, path, "must be a positive integer")
}
const isoDate: Checker = (value, path, issues) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    add(issues, path, "must be an ISO-8601 timestamp")
  }
}
const uuid: Checker = (value, path, issues) => {
  if (!isUuid(value)) add(issues, path, "must be a UUID")
}
const uuidV7: Checker = (value, path, issues) => {
  if (!isUuidV7(value)) add(issues, path, "must be a UUIDv7")
}
const zmxName: Checker = (value, path, issues) => {
  if (!isZmxName(value)) add(issues, path, "must be a Rubato zmx name")
}
const jsonObject: Checker = (value, path, issues) => {
  if (!plainRecord(value)) add(issues, path, "must be an object")
  else if (!isJsonValue(value)) add(issues, path, "must contain only JSON values")
}
const protocol: Checker = literal(REMOTE_PROTOCOL_NAME)
const pathString: Checker = (value, path, issues) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    add(issues, path, "must be a non-empty path of at most 4096 characters without NUL")
  }
}
const httpsUrl: Checker = (value, path, issues) => {
  if (typeof value !== "string") return add(issues, path, "must be an HTTPS URL")
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) add(issues, path, "must be an HTTPS URL without credentials")
  } catch {
    add(issues, path, "must be an HTTPS URL")
  }
}
const httpsOrigin: Checker = (value, path, issues) => {
  if (typeof value !== "string") return add(issues, path, "must be an exact HTTPS origin")
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.username || url.password) {
      add(issues, path, "must be an exact HTTPS origin")
    }
  } catch {
    add(issues, path, "must be an exact HTTPS origin")
  }
}
const base64: Checker = (value, path, issues) => {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    add(issues, path, "must be canonical base64")
  }
}

export const surfaceRegisterFrameSchema = makeSchema<SurfaceRegisterFrame>((value, issues) => {
  object({
    kind: literal("surface.register"),
    protocol,
    protocolRange: protocolRange,
    surfaceInstanceId: uuid,
    summary: nested(liveSessionSummarySchema),
  }, { token: opaqueCredential, reconnectToken: opaqueCredential })(value, "$", issues)
  if (plainRecord(value) && !("token" in value) && !("reconnectToken" in value)) {
    add(issues, "$", "must include token or reconnectToken")
  }
  if (plainRecord(value) && plainRecord(value["protocolRange"]) && plainRecord(value["summary"])) {
    const build = value["summary"]["build"]
    if (plainRecord(build) && (
      value["protocolRange"]["min"] !== build["remoteProtocolMin"] ||
      value["protocolRange"]["max"] !== build["remoteProtocolMax"]
    )) add(issues, "$.protocolRange", "must match summary.build protocol range")
  }
})

export const surfaceHeartbeatFrameSchema = makeSchema<SurfaceHeartbeatFrame>(root(object({
  kind: literal("surface.heartbeat"), protocol, surfaceInstanceId: uuid, sourceSeq: nonNegativeInteger, at: isoDate,
})))

export const surfaceEventFrameSchema = makeSchema<SurfaceEventFrame>((value, issues) => {
  object({
    kind: literal("surface.event"), protocol, liveSessionId: uuidV7, surfaceInstanceId: uuid,
    sourceSeq: positiveInteger, at: isoDate, type: oneOf(REMOTE_EVENT_TYPES), payload: jsonObject,
  })(value, "$", issues)
})

export const surfaceSnapshotFrameSchema = makeSchema<SurfaceSnapshotFrame>(root(object({
  kind: literal("surface.snapshot"), protocol, surfaceInstanceId: uuid, sourceSeq: nonNegativeInteger,
  at: isoDate, summary: nested(liveSessionSummarySchema), state: sessionSnapshotState,
})))

export const surfaceSummaryFrameSchema = makeSchema<SurfaceSummaryFrame>(root(object({
  kind: literal("surface.summary"), protocol, surfaceInstanceId: uuid, sourceSeq: nonNegativeInteger,
  at: isoDate, summary: nested(liveSessionSummarySchema),
})))

export const surfaceActionResultFrameSchema = makeSchema<SurfaceActionResultFrame>(root(object({
  kind: literal("surface.action-result"), protocol, requestId: uuid, accepted: booleanCheck,
  revision: nonNegativeInteger, payload: jsonObject,
})))

export const bootstrapClaimFrameSchema = makeSchema<BootstrapClaimFrame>(root(object({
  kind: literal("bootstrap.claim"), protocol, token: opaqueCredential,
})))

const bootstrapLaunchPayload: Checker = object({
  schemaVersion: literal(1), liveSessionId: uuidV7, hostId: uuidV7, zmxName,
  labels: stringRecord, cwd: pathString, argv: arrayOf(boundedString(4096), 64), env: stringRecord,
  launcherPath: pathString, zmxBinary: pathString, hubSocket: pathString, surfaceToken: opaqueCredential,
})
export const bootstrapLaunchPayloadSchema = makeSchema<BootstrapLaunchPayload>(root(bootstrapLaunchPayload))
export const hubLaunchFrameSchema = makeSchema<HubLaunchFrame>(root(object({
  kind: literal("hub.launch"), protocol, launch: bootstrapLaunchPayload,
})))

export const hubRegisteredFrameSchema = makeSchema<HubRegisteredFrame>((value, issues) => {
  object({
    kind: literal("hub.registered"), protocol, hostSeq: nonNegativeInteger, reconnectToken: opaqueCredential,
    protocolRange, negotiation: protocolNegotiation,
  })(value, "$", issues)
  if (plainRecord(value)) validateNegotiatedRange(value["protocolRange"], value["negotiation"], "$", issues)
})

export const hubActionFrameSchema = makeSchema<HubActionFrame>(root(object({
  kind: literal("hub.action"), protocol, request: nested(actionRequestSchema),
})))

export const surfaceToHubFrameSchema = makeSchema<SurfaceToHubFrame>(root(discriminated("kind", {
  "bootstrap.claim": schemaChecker(bootstrapClaimFrameSchema),
  "surface.register": schemaChecker(surfaceRegisterFrameSchema),
  "surface.heartbeat": schemaChecker(surfaceHeartbeatFrameSchema),
  "surface.event": schemaChecker(surfaceEventFrameSchema),
  "surface.snapshot": schemaChecker(surfaceSnapshotFrameSchema),
  "surface.summary": schemaChecker(surfaceSummaryFrameSchema),
  "surface.action-result": schemaChecker(surfaceActionResultFrameSchema),
})))

export const hubToSurfaceFrameSchema = makeSchema<HubToSurfaceFrame>(root(discriminated("kind", {
  "hub.launch": schemaChecker(hubLaunchFrameSchema),
  "hub.registered": schemaChecker(hubRegisteredFrameSchema),
  "hub.action": schemaChecker(hubActionFrameSchema),
})))

export const surfaceReconnectCredentialPayloadSchema = makeSchema<SurfaceReconnectCredentialPayload>(root(object({
  schemaVersion: literal(1), liveSessionId: uuidV7, surfaceInstanceId: uuid, expiresAt: positiveInteger, nonce: opaqueCredential,
})))

export const sessionSnapshotStateSchema = makeSchema<SessionSnapshotState>(root(sessionSnapshotState))
export const snapshotResponseSchema = makeSchema<SnapshotResponse>(root(object({
  summary: nested(liveSessionSummarySchema), revision: nonNegativeInteger, lastSeq: nonNegativeInteger,
  entries: arrayOf(conversationEntry), tree: arrayOf(object({ id: nonEmptyString, label: stringCheck, current: booleanCheck })),
  commands: arrayOf(interactiveCommandDescriptor),
}, { uiRequest, timeline: nested(requestTimelineSnapshotSchema) })))
export const sessionSnapshotSchema = makeSchema<SessionSnapshot>((value, issues) => {
  object({
    schemaVersion: literal(1), liveSessionId: uuidV7, lastSeq: nonNegativeInteger, writtenAt: isoDate,
    summary: nested(liveSessionSummarySchema), state: sessionSnapshotState,
  })(value, "$", issues)
  if (plainRecord(value) && plainRecord(value["summary"]) && value["liveSessionId"] !== value["summary"]["liveSessionId"]) {
    add(issues, "$.liveSessionId", "must match summary.liveSessionId")
  }
})
export const snapshotRequiredFrameSchema = makeSchema<SnapshotRequiredFrame>((value, issues) => {
  object({ type: literal("snapshot.required"), protocol, liveSessionId: uuidV7 }, { snapshot: nested(sessionSnapshotSchema) })(value, "$", issues)
  if (plainRecord(value) && plainRecord(value["snapshot"]) && value["liveSessionId"] !== value["snapshot"]["liveSessionId"]) {
    add(issues, "$.liveSessionId", "must match snapshot.liveSessionId")
  }
})

export const healthResponseSchema = makeSchema<HealthResponse>(root(object({ ok: literal(true), hostId: uuidV7 })))
export const hostDescriptionResponseSchema = makeSchema<HostDescriptionResponse>((value, issues) => {
  object({
    hostId: uuidV7, displayName: nonEmptyString, ownerLogin: nonEmptyString, protocol: protocolRange,
    negotiation: protocolNegotiation, capabilities: arrayOf(nonEmptyString), pushPublicKey: nonEmptyString,
  })(value, "$", issues)
  if (plainRecord(value)) validateNegotiatedRange(value["protocol"], value["negotiation"], "$", issues)
})
export const registeredHostSchema = makeSchema<RegisteredHost>((value, issues) => {
  object({
    hostId: uuidV7, displayName: nonEmptyString, baseUrl: httpsUrl, ownerLogin: nonEmptyString, pairedAt: isoDate,
  }, { lastSeenAt: isoDate, protocolMin: positiveInteger, protocolMax: positiveInteger })(value, "$", issues)
  if (plainRecord(value)) validateOptionalRangePair(value, "$", issues)
})
export const hostInventorySchema = makeSchema<HostInventory>(root(object({
  host: nested(registeredHostSchema), sessions: arrayOf(nested(liveSessionSummarySchema)),
  connection: oneOf(["online", "connecting", "offline", "incompatible", "denied"] as const),
}, { problem: nonEmptyString })))
export const hostInventoryResponseSchema = makeSchema<HostInventoryResponse>(root(object({
  hostSeq: nonNegativeInteger, sessions: arrayOf(nested(liveSessionSummarySchema)),
})))

export const pairingQrPayloadSchema = makeSchema<PairingQrPayload>(root(object({
  type: literal("rubato-host-pair"), baseUrl: httpsUrl, hostId: uuidV7, nonce: opaqueCredential, expiresAt: isoDate,
})))
export const pairClaimRequestSchema = makeSchema<PairClaimRequest>(root(object({ nonce: opaqueCredential })))
export const pairClaimResponseSchema = makeSchema<PairClaimResponse>(root(object({ claimId: uuid, expiresAt: isoDate })))
export const pairApproveRequestSchema = makeSchema<PairApproveRequest>(root(object({ claimId: uuid, confirmed: literal(true) })))
export const pairApproveResponseSchema = makeSchema<PairApproveResponse>(root(object({ paired: literal(true), origin: httpsOrigin })))
export const webSocketTicketRequestSchema = makeSchema<WebSocketTicketRequest>(root(object({ purpose: literal("events") })))
export const terminalTicketRequestSchema = makeSchema<TerminalTicketRequest>(root(object({ purpose: literal("terminal") })))
export const ticketResponseSchema = makeSchema<TicketResponse>(root(object({ ticket: opaqueCredential, expiresAt: isoDate })))

export const createLiveSessionRequestSchema = makeSchema<CreateLiveSessionRequest>(root(object({
  cwd: pathString, attachAfterCreate: booleanCheck,
}, {
  name: boundedString(200), initialPrompt: boundedString(256 * 1024),
  model: object({ provider: nonEmptyString, modelId: nonEmptyString }), thinkingLevel: nonEmptyString,
  rubatoArgs: arrayOf(boundedString(4096), 64),
})))
export const createLiveSessionResponseSchema = makeSchema<CreateLiveSessionResponse>(root(object({
  liveSessionId: uuidV7, zmxName,
})))
export const terminateLiveSessionRequestSchema = makeSchema<TerminateLiveSessionRequest>(root(object({}, { force: booleanCheck })))
export const terminateLiveSessionResponseSchema = makeSchema<TerminateLiveSessionResponse>(root(object({ terminated: literal(true) })))
export const actionResultResponseSchema = makeSchema<ActionResultResponse>(root(object({
  accepted: booleanCheck, revision: nonNegativeInteger, payload: jsonObject,
})))

export const messagePageRequestSchema = makeSchema<MessagePageRequest>(root(object({}, {
  before: nonEmptyString, limit: integerRange(1, 100),
})))
export const messagePageResponseSchema = makeSchema<MessagePageResponse>(root(object({
  entries: arrayOf(conversationEntry),
}, { nextBefore: nonEmptyString, requestRuns: arrayOf(nested(requestRunSummarySchema)) })))
export const imageUploadRequestSchema = makeSchema<ImageUploadRequest>(root(object({
  fileName: boundedString(255), mimeType: oneOf(["image/png", "image/jpeg", "image/webp", "image/gif"] as const), dataBase64: base64,
})))
export const imageUploadResponseSchema = makeSchema<ImageUploadResponse>(root(object({
  imageId: nonEmptyString, mimeType: nonEmptyString, byteLength: nonNegativeInteger,
})))
export const artifactRequestSchema = makeSchema<ArtifactRequest>(root(object({ artifactId: nonEmptyString })))
export const artifactResponseSchema = makeSchema<ArtifactResponse>(root(object({
  artifactId: nonEmptyString, contentType: nonEmptyString, encoding: oneOf(["utf8", "base64"] as const),
  content: stringCheck, byteLength: nonNegativeInteger, truncated: booleanCheck,
})))
export const fileReadRequestSchema = makeSchema<FileReadRequest>(root(object({ path: pathString }, { maxBytes: integerRange(1, 8 * 1024 * 1024) })))
export const fileReadResponseSchema = makeSchema<FileReadResponse>(root(object({
  path: pathString, content: stringCheck, encoding: oneOf(["utf8", "base64"] as const),
  byteLength: nonNegativeInteger, truncated: booleanCheck,
}, { language: nonEmptyString })))

const gitStatusEntry = object({ path: pathString, status: nonEmptyString })
const gitDiffFile = object({ fileName: nonEmptyString, fileLang: stringCheck, content: stringCheck })
const gitDiff = object({ oldFile: gitDiffFile, newFile: gitDiffFile, hunks: arrayOf(stringCheck) })
export const gitStatusResponseSchema = makeSchema<GitStatusResponse>(root(object({ files: arrayOf(gitStatusEntry) })))
export const gitDiffRequestSchema = makeSchema<GitDiffRequest>(root(object({}, { path: pathString, contextLines: integerRange(0, 1000) })))
export const gitDiffResponseSchema = makeSchema<GitDiffResponse>(root(object({ diff: gitDiff, summary: stringCheck })))

const projectChoice = object({ path: pathString, label: nonEmptyString, source: oneOf(["recent", "favorite", "browse"] as const) })
export const projectListResponseSchema = makeSchema<ProjectListResponse>(root(object({ projects: arrayOf(projectChoice) })))
export const projectFavoritesUpdateRequestSchema = makeSchema<ProjectFavoritesUpdateRequest>(root(object({ paths: arrayOf(pathString, 1000) })))
export const projectFavoritesUpdateResponseSchema = makeSchema<ProjectFavoritesUpdateResponse>(root(object({ projects: arrayOf(projectChoice) })))
export const projectBrowseRequestSchema = makeSchema<ProjectBrowseRequest>(root(object({}, {
  path: pathString, showHidden: booleanCheck, cursor: nonEmptyString, limit: integerRange(1, 200),
})))
export const projectBrowseResponseSchema = makeSchema<ProjectBrowseResponse>(root(object({
  path: pathString, directories: arrayOf(object({ name: nonEmptyString, path: pathString, symlink: booleanCheck }), 200),
}, { parentPath: pathString, nextCursor: nonEmptyString })))

const pushSubscription = object({
  endpoint: httpsUrl,
  keys: object({ auth: nonEmptyString, p256dh: nonEmptyString }),
}, { expirationTime: nullable(nonNegativeInteger) })
export const pushSubscribeRequestSchema = makeSchema<PushSubscribeRequest>(root(object({ subscription: pushSubscription })))
export const pushSubscribeResponseSchema = makeSchema<PushSubscribeResponse>(root(object({ vapidPublicKey: nonEmptyString, createdAt: isoDate })))
export const pushProfileExportRequestSchema = makeSchema<PushProfileExportRequest>(root(object({ destinationPublicKey: base64 })))
const encryptedPushProfile = object({
  schemaVersion: literal(1), ephemeralPublicKey: base64, salt: base64, nonce: base64, tag: base64, ciphertext: base64,
})
export const encryptedPushProfileSchema = makeSchema<EncryptedPushProfile>(root(encryptedPushProfile))
export const pushProfileImportRequestSchema = encryptedPushProfileSchema
export const pushProfileImportResponseSchema = makeSchema<PushProfileImportResponse>(root(object({ imported: literal(true), pwaOrigin: httpsOrigin })))
export const pushRotateResponseSchema = makeSchema<PushRotateResponse>(root(object({ requiresResubscribe: literal(true), vapidPublicKey: nonEmptyString })))
export const pushEnvelopeSchema = makeSchema<PushEnvelope>(root(object({
  type: oneOf(["session-settled", "attention-required", "session-error", "team-failed"] as const),
  hostId: uuidV7, liveSessionId: uuidV7, title: nonEmptyString, body: stringCheck, url: stringCheck,
})))

export const HTTP_REQUEST_SCHEMAS = Object.freeze({
  pairClaim: pairClaimRequestSchema,
  pairApprove: pairApproveRequestSchema,
  webSocketTicket: webSocketTicketRequestSchema,
  terminalTicket: terminalTicketRequestSchema,
  createLiveSession: createLiveSessionRequestSchema,
  terminateLiveSession: terminateLiveSessionRequestSchema,
  messagePage: messagePageRequestSchema,
  imageUpload: imageUploadRequestSchema,
  action: actionRequestSchema,
  artifact: artifactRequestSchema,
  fileRead: fileReadRequestSchema,
  gitDiff: gitDiffRequestSchema,
  projectFavoritesUpdate: projectFavoritesUpdateRequestSchema,
  projectBrowse: projectBrowseRequestSchema,
  pushSubscribe: pushSubscribeRequestSchema,
  pushProfileExport: pushProfileExportRequestSchema,
  pushProfileImport: pushProfileImportRequestSchema,
})

export const HTTP_RESPONSE_SCHEMAS = Object.freeze({
  health: healthResponseSchema,
  hostDescription: hostDescriptionResponseSchema,
  inventory: hostInventoryResponseSchema,
  pairClaim: pairClaimResponseSchema,
  pairApprove: pairApproveResponseSchema,
  ticket: ticketResponseSchema,
  createLiveSession: createLiveSessionResponseSchema,
  terminateLiveSession: terminateLiveSessionResponseSchema,
  actionResult: actionResultResponseSchema,
  snapshot: snapshotResponseSchema,
  messagePage: messagePageResponseSchema,
  imageUpload: imageUploadResponseSchema,
  artifact: artifactResponseSchema,
  fileRead: fileReadResponseSchema,
  gitStatus: gitStatusResponseSchema,
  gitDiff: gitDiffResponseSchema,
  projectList: projectListResponseSchema,
  projectFavoritesUpdate: projectFavoritesUpdateResponseSchema,
  projectBrowse: projectBrowseResponseSchema,
  pushSubscribe: pushSubscribeResponseSchema,
  pushProfileExport: encryptedPushProfileSchema,
  pushProfileImport: pushProfileImportResponseSchema,
  pushRotate: pushRotateResponseSchema,
})

function makeSchema<T>(validate: (input: unknown, issues: ValidationIssue[]) => void): ProtocolSchema<T> {
  const safeParse = (input: unknown): ValidationResult<T> => {
    const issues: ValidationIssue[] = []
    validate(input, issues)
    return issues.length === 0 ? { ok: true, value: input as T } : { ok: false, issues }
  }
  return Object.freeze({
    safeParse,
    parse(input: unknown): T {
      const result = safeParse(input)
      if (!result.ok) throw new ProtocolValidationError(result.issues)
      return result.value
    },
  })
}

function root(checker: Checker): (input: unknown, issues: ValidationIssue[]) => void {
  return (input, issues) => checker(input, "$", issues)
}

function object(required: Shape, optional: Shape = {}): Checker {
  return (value, path, issues) => {
    if (!plainRecord(value)) return add(issues, path, "must be an object")
    const allowed = new Set([...Object.keys(required), ...Object.keys(optional)])
    for (const key of Object.keys(value)) if (!allowed.has(key)) add(issues, `${path}.${key}`, "is not allowed")
    for (const [key, checker] of Object.entries(required)) {
      if (!(key in value)) add(issues, `${path}.${key}`, "is required")
      else checker(value[key], `${path}.${key}`, issues)
    }
    for (const [key, checker] of Object.entries(optional)) if (key in value) checker(value[key], `${path}.${key}`, issues)
  }
}

function arrayOf(checker: Checker, maxItems = Number.MAX_SAFE_INTEGER): Checker {
  return (value, path, issues) => {
    if (!Array.isArray(value)) return add(issues, path, "must be an array")
    if (value.length > maxItems) add(issues, path, `must contain at most ${maxItems} items`)
    value.forEach((member, index) => checker(member, `${path}[${index}]`, issues))
  }
}

function nullable(checker: Checker): Checker {
  return (value, path, issues) => { if (value !== null) checker(value, path, issues) }
}

function literal(expected: string | number | boolean): Checker {
  return (value, path, issues) => { if (value !== expected) add(issues, path, `must equal ${JSON.stringify(expected)}`) }
}

function oneOf<const T extends readonly string[]>(values: T): Checker {
  return (value, path, issues) => {
    if (typeof value !== "string" || !values.some((candidate) => candidate === value)) {
      add(issues, path, `must be one of ${values.join(", ")}`)
    }
  }
}

function boundedString(maxLength: number): Checker {
  return (value, path, issues) => {
    if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
      add(issues, path, `must be a string of at most ${maxLength} characters without NUL`)
    }
  }
}

function integerRange(min: number, max: number): Checker {
  return (value, path, issues) => {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
      add(issues, path, `must be an integer from ${min} through ${max}`)
    }
  }
}

function protocolRange(value: unknown, path: string, issues: ValidationIssue[]): void {
  object({ min: positiveInteger, max: positiveInteger })(value, path, issues)
  if (!plainRecord(value) || typeof value["min"] !== "number" || typeof value["max"] !== "number") return
  if (value["min"] > value["max"]) add(issues, `${path}.min`, "must not exceed max")
  if (value["max"] - value["min"] > 1) add(issues, path, "must advertise only protocol N and N-1")
}

function protocolNegotiation(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!plainRecord(value)) return add(issues, path, "must be an object")
  if (value["compatible"] === true) object({ compatible: literal(true), version: positiveInteger })(value, path, issues)
  else if (value["compatible"] === false) object({ compatible: literal(false), reason: literal("protocol_mismatch") })(value, path, issues)
  else add(issues, `${path}.compatible`, "must be a boolean")
}

function opaqueCredential(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 16 * 1024 || /\s/.test(value)) {
    add(issues, path, "must be a non-empty opaque credential without whitespace")
  }
}

function stringRecord(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!plainRecord(value)) return add(issues, path, "must be an object")
  for (const [key, member] of Object.entries(value)) {
    if (!key || typeof member !== "string") add(issues, `${path}.${key}`, "must be a string")
  }
}

function conversationEntry(value: unknown, path: string, issues: ValidationIssue[]): void {
  const requestRunId = nonEmptyString
  discriminated("kind", {
    message: object({ id: nonEmptyString, kind: literal("message"), role: oneOf(["user", "assistant"] as const), text: stringCheck }, {
      streaming: booleanCheck,
      at: isoDate,
      requestRunId,
      inputId: requestRunId,
      delivery: oneOf(["submit", "steer", "followUp"] as const),
      phase: oneOf(["progress", "final"] as const),
    }),
    thinking: object({ id: nonEmptyString, kind: literal("thinking"), text: stringCheck }, { streaming: booleanCheck }),
    tool: object({ id: nonEmptyString, kind: literal("tool"), name: nonEmptyString, summary: stringCheck, status: oneOf(["running", "done", "failed"] as const) }, {
      output: stringCheck,
      artifactId: nonEmptyString,
      requestRunId,
      at: isoDate,
      completedAt: isoDate,
    }),
    image: object({ id: nonEmptyString, kind: literal("image"), alt: stringCheck, url: stringCheck }, { requestRunId }),
    notice: object({ id: nonEmptyString, kind: literal("notice"), text: stringCheck }, { requestRunId }),
  })(value, path, issues)
}

function uiRequest(value: unknown, path: string, issues: ValidationIssue[]): void {
  object({ requestId: nonEmptyString, kind: oneOf(["select", "confirm", "input"] as const), title: nonEmptyString }, {
    message: stringCheck,
    options: arrayOf(object({ label: nonEmptyString, value: stringCheck })),
    placeholder: stringCheck,
  })(value, path, issues)
}

function interactiveCommandDescriptor(value: unknown, path: string, issues: ValidationIssue[]): void {
  object({
    name: nonEmptyString,
    description: stringCheck,
    category: oneOf(["builtin", "extension", "skill", "template"] as const),
    remoteMode: oneOf(["direct", "native-action", "terminal-only"] as const),
  })(value, path, issues)
}

function sessionSnapshotState(value: unknown, path: string, issues: ValidationIssue[]): void {
  object({
    revision: nonNegativeInteger,
    entries: arrayOf(conversationEntry),
    tree: arrayOf(object({ id: nonEmptyString, label: stringCheck, current: booleanCheck })),
    commands: arrayOf(interactiveCommandDescriptor),
    capabilities: arrayOf(nonEmptyString),
  }, {
    streamingMessage: jsonObject,
    activeTools: arrayOf(jsonObject),
    uiRequest,
    background: jsonObject,
    teams: jsonObject,
    timeline: nested(requestTimelineSnapshotSchema),
  })(value, path, issues)
}

function discriminated(key: string, variants: Readonly<Record<string, Checker>>): Checker {
  return (value, path, issues) => {
    if (!plainRecord(value)) return add(issues, path, "must be an object")
    const discriminator = value[key]
    if (typeof discriminator !== "string" || !(discriminator in variants)) {
      add(issues, `${path}.${key}`, `must be one of ${Object.keys(variants).join(", ")}`)
      return
    }
    variants[discriminator]!(value, path, issues)
  }
}

function nested<T>(schema: ProtocolSchema<T>): Checker {
  return (value, path, issues) => {
    const result = schema.safeParse(value)
    if (result.ok) return
    for (const nestedIssue of result.issues) {
      issues.push({ path: nestedIssue.path === "$" ? path : `${path}${nestedIssue.path.slice(1)}`, message: nestedIssue.message })
    }
  }
}

function schemaChecker<T>(schema: ProtocolSchema<T>): Checker {
  return nested(schema)
}

function validateNegotiatedRange(range: unknown, negotiation: unknown, path: string, issues: ValidationIssue[]): void {
  if (!plainRecord(range) || !plainRecord(negotiation) || negotiation["compatible"] !== true) return
  const version = negotiation["version"]
  if (typeof version === "number" && (version < (range["min"] as number) || version > (range["max"] as number))) {
    add(issues, `${path}.negotiation.version`, "must be within the advertised protocol range")
  }
}

function validateOptionalRangePair(value: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  const hasMin = "protocolMin" in value
  const hasMax = "protocolMax" in value
  if (hasMin !== hasMax) add(issues, path, "protocolMin and protocolMax must be supplied together")
  if (typeof value["protocolMin"] === "number" && typeof value["protocolMax"] === "number") {
    protocolRange({ min: value["protocolMin"], max: value["protocolMax"] }, path, issues)
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function add(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message })
}
