import {
  REMOTE_EVENT_TYPES,
  REMOTE_PROTOCOL_NAME,
} from "./constants.js"
import { isUuid, isUuidV7, isZmxName } from "./identifiers.js"
import type {
  ActionResultResponse,
  PairingQrPayload,
} from "./http.js"
import type {
  BootstrapClaimFrame,
  BootstrapLaunchPayload,
  HubActionFrame,
  HubLaunchFrame,
  HubRegisteredFrame,
  HubRejectedFrame,
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
import {
  actionRequestSchema,
  isJsonValue,
  liveSessionSummarySchema,
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

const rejectionReason: Checker = (value, path, issues) => {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\0")) {
    add(issues, path, "must be a string of 1 to 4096 characters without NUL")
  }
}
export const hubRejectedFrameSchema = makeSchema<HubRejectedFrame>(root(object({
  kind: literal("hub.rejected"), protocol, reason: rejectionReason,
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
  "hub.rejected": schemaChecker(hubRejectedFrameSchema),
})))

export const surfaceReconnectCredentialPayloadSchema = makeSchema<SurfaceReconnectCredentialPayload>(root(object({
  schemaVersion: literal(1), liveSessionId: uuidV7, surfaceInstanceId: uuid, expiresAt: positiveInteger, nonce: opaqueCredential,
})))

export const sessionSnapshotStateSchema = makeSchema<SessionSnapshotState>(root(sessionSnapshotState))
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

export const pairingQrPayloadSchema = makeSchema<PairingQrPayload>(root(object({
  type: literal("rubato-host-pair"), baseUrl: httpsUrl, hostId: uuidV7, nonce: opaqueCredential, expiresAt: isoDate,
})))
export const actionResultResponseSchema = makeSchema<ActionResultResponse>(root(object({
  accepted: booleanCheck, revision: nonNegativeInteger, payload: jsonObject,
})))

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
