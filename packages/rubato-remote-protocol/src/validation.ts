import {
  LEAD_EXECUTIONS,
  LIVE_LIFECYCLES,
  LIVE_SESSION_SCHEMA_VERSION,
  REMOTE_ACTION_TYPES,
  REMOTE_ERROR_CODES,
  REMOTE_EVENT_TYPES,
  REMOTE_PROTOCOL_NAME,
} from "./constants.js"
import { isUuid, isUuidV7, isZmxName, zmxNameForLiveSession } from "./identifiers.js"
import type {
  ActionRequestEnvelope,
  ClientResumeRequest,
  EventEnvelope,
  JsonObject,
  JsonValue,
  LiveSessionSummary,
  RemoteActionType,
  RemoteErrorResponse,
} from "./types.js"

export interface ValidationIssue {
  readonly path: string
  readonly message: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

export interface ProtocolSchema<T> {
  readonly safeParse: (input: unknown) => ValidationResult<T>
  readonly parse: (input: unknown) => T
}

export class ProtocolValidationError extends TypeError {
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "))
    this.name = "ProtocolValidationError"
    this.issues = issues
  }
}

export const liveSessionSummarySchema = schema(validateLiveSessionSummary)
export const actionRequestSchema = schema(validateActionRequest)
export const eventEnvelopeSchema = schema(validateEventEnvelope)
export const clientResumeSchema = schema(validateClientResumeRequest)
export const remoteErrorResponseSchema = schema(validateRemoteErrorResponse)

export function validateLiveSessionSummary(input: unknown): ValidationResult<LiveSessionSummary> {
  const issues: ValidationIssue[] = []
  if (!record(input, "$", issues)) return failure(issues)
  exactKeys(
    input,
    [
      "schemaVersion",
      "hostId",
      "liveSessionId",
      "zmxName",
      "managed",
      "pid",
      "lifecycle",
      "execution",
      "attention",
      "title",
      "cwd",
      "createdAt",
      "lastAssistantAt",
      "pi",
      "model",
      "context",
      "cache",
      "background",
      "teams",
      "build",
      "capabilities",
    ],
    "$",
    issues,
  )
  literal(input["schemaVersion"], LIVE_SESSION_SCHEMA_VERSION, "$.schemaVersion", issues)
  uuidV7(input["hostId"], "$.hostId", issues)
  uuidV7(input["liveSessionId"], "$.liveSessionId", issues)
  optional(input, "zmxName", (value) => {
    if (!isZmxName(value)) issue(issues, "$.zmxName", "must be a Rubato zmx name")
    if (isZmxName(value) && isUuidV7(input["liveSessionId"]) && value !== zmxNameForLiveSession(input["liveSessionId"])) {
      issue(issues, "$.zmxName", "must be derived from liveSessionId")
    }
  })
  booleanValue(input["managed"], "$.managed", issues)
  optional(input, "pid", (value) => positiveInteger(value, "$.pid", issues))
  oneOf(input["lifecycle"], LIVE_LIFECYCLES, "$.lifecycle", issues)
  oneOf(input["execution"], LEAD_EXECUTIONS, "$.execution", issues)
  booleanValue(input["attention"], "$.attention", issues)
  stringValue(input["title"], "$.title", issues)
  stringValue(input["cwd"], "$.cwd", issues)
  isoDate(input["createdAt"], "$.createdAt", issues)
  optional(input, "lastAssistantAt", (value) => isoDate(value, "$.lastAssistantAt", issues))

  validatePi(input["pi"], issues)
  validateModel(input["model"], issues)
  validateContext(input["context"], issues)
  validateCache(input["cache"], issues)
  validateBackground(input["background"], issues)
  validateTeams(input["teams"], issues)
  validateBuild(input["build"], issues)
  stringArray(input["capabilities"], "$.capabilities", issues)

  return finish(input as unknown as LiveSessionSummary, issues)
}

export function validateActionRequest(input: unknown): ValidationResult<ActionRequestEnvelope> {
  const issues: ValidationIssue[] = []
  if (!record(input, "$", issues)) return failure(issues)
  exactKeys(input, ["protocol", "requestId", "hostId", "liveSessionId", "action", "expectedRevision", "payload"], "$", issues)
  literal(input["protocol"], REMOTE_PROTOCOL_NAME, "$.protocol", issues)
  uuid(input["requestId"], "$.requestId", issues)
  uuidV7(input["hostId"], "$.hostId", issues)
  uuidV7(input["liveSessionId"], "$.liveSessionId", issues)
  oneOf(input["action"], REMOTE_ACTION_TYPES, "$.action", issues)
  optional(input, "expectedRevision", (value) => nonNegativeInteger(value, "$.expectedRevision", issues))
  if (typeof input["action"] === "string" && includes(REMOTE_ACTION_TYPES, input["action"])) {
    validateActionPayload(input["action"], input["payload"], issues)
  } else if (!record(input["payload"], "$.payload", issues)) {
    // The payload shape cannot be selected without a valid action.
  }
  return finish(input as unknown as ActionRequestEnvelope, issues)
}

export function validateEventEnvelope(input: unknown): ValidationResult<EventEnvelope> {
  const issues: ValidationIssue[] = []
  if (!record(input, "$", issues)) return failure(issues)
  exactKeys(input, ["protocol", "hostId", "liveSessionId", "seq", "at", "type", "payload"], "$", issues)
  literal(input["protocol"], REMOTE_PROTOCOL_NAME, "$.protocol", issues)
  uuidV7(input["hostId"], "$.hostId", issues)
  uuidV7(input["liveSessionId"], "$.liveSessionId", issues)
  positiveInteger(input["seq"], "$.seq", issues)
  isoDate(input["at"], "$.at", issues)
  oneOf(input["type"], REMOTE_EVENT_TYPES, "$.type", issues)
  if (record(input["payload"], "$.payload", issues) && !isJsonValue(input["payload"])) {
    issue(issues, "$.payload", "must contain only JSON values")
  }
  return finish(input as unknown as EventEnvelope, issues)
}

export function validateClientResumeRequest(input: unknown): ValidationResult<ClientResumeRequest> {
  const issues: ValidationIssue[] = []
  if (!record(input, "$", issues)) return failure(issues)
  exactKeys(input, ["type", "sessions"], "$", issues)
  literal(input["type"], "client.resume", "$.type", issues)
  if (!Array.isArray(input["sessions"])) {
    issue(issues, "$.sessions", "must be an array")
  } else {
    input["sessions"].forEach((session, index) => {
      const path = `$.sessions[${index}]`
      if (!record(session, path, issues)) return
      exactKeys(session, ["liveSessionId", "lastSeq"], path, issues)
      uuidV7(session["liveSessionId"], `${path}.liveSessionId`, issues)
      nonNegativeInteger(session["lastSeq"], `${path}.lastSeq`, issues)
    })
  }
  return finish(input as unknown as ClientResumeRequest, issues)
}

export function validateRemoteErrorResponse(input: unknown): ValidationResult<RemoteErrorResponse> {
  const issues: ValidationIssue[] = []
  if (!record(input, "$", issues)) return failure(issues)
  exactKeys(input, ["error"], "$", issues)
  if (record(input["error"], "$.error", issues)) {
    const error = input["error"]
    exactKeys(error, ["code", "message", "traceId", "details"], "$.error", issues)
    oneOf(error["code"], REMOTE_ERROR_CODES, "$.error.code", issues)
    nonEmptyString(error["message"], "$.error.message", issues)
    nonEmptyString(error["traceId"], "$.error.traceId", issues)
    optional(error, "details", (value) => {
      if (record(value, "$.error.details", issues) && !isJsonValue(value)) {
        issue(issues, "$.error.details", "must contain only JSON values")
      }
    })
  }
  return finish(input as unknown as RemoteErrorResponse, issues)
}

export function isJsonValue(value: unknown): value is JsonValue {
  return jsonValue(value, new Set<object>())
}

function validateActionPayload(action: RemoteActionType, input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.payload", issues)) return
  switch (action) {
    case "input.submit":
      exactKeys(input, ["text", "imageIds", "delivery"], "$.payload", issues)
      stringValue(input["text"], "$.payload.text", issues)
      optional(input, "imageIds", (value) => stringArray(value, "$.payload.imageIds", issues))
      optional(input, "delivery", (value) => literal(value, "auto", "$.payload.delivery", issues))
      return
    case "input.steer":
    case "input.followUp":
      exactKeys(input, ["text", "imageIds"], "$.payload", issues)
      stringValue(input["text"], "$.payload.text", issues)
      optional(input, "imageIds", (value) => stringArray(value, "$.payload.imageIds", issues))
      return
    case "agent.abort":
    case "session.new":
    case "session.reload":
    case "bash.abort":
    case "environment.refresh":
      exactKeys(input, [], "$.payload", issues)
      return
    case "session.compact":
      exactKeys(input, ["instructions"], "$.payload", issues)
      optional(input, "instructions", (value) => stringValue(value, "$.payload.instructions", issues))
      return
    case "session.navigate":
      exactKeys(input, ["targetEntryId", "summarize", "instructions"], "$.payload", issues)
      nonEmptyString(input["targetEntryId"], "$.payload.targetEntryId", issues)
      optional(input, "summarize", (value) => booleanValue(value, "$.payload.summarize", issues))
      optional(input, "instructions", (value) => stringValue(value, "$.payload.instructions", issues))
      return
    case "session.fork":
      exactKeys(input, ["targetEntryId"], "$.payload", issues)
      optional(input, "targetEntryId", (value) => nonEmptyString(value, "$.payload.targetEntryId", issues))
      return
    case "session.rename":
      exactKeys(input, ["name"], "$.payload", issues)
      nonEmptyString(input["name"], "$.payload.name", issues)
      return
    case "model.set":
      exactKeys(input, ["provider", "modelId"], "$.payload", issues)
      nonEmptyString(input["provider"], "$.payload.provider", issues)
      nonEmptyString(input["modelId"], "$.payload.modelId", issues)
      return
    case "thinking.set":
      exactKeys(input, ["level"], "$.payload", issues)
      nonEmptyString(input["level"], "$.payload.level", issues)
      return
    case "bash.execute":
      exactKeys(input, ["command", "excludeFromContext"], "$.payload", issues)
      stringValue(input["command"], "$.payload.command", issues)
      booleanValue(input["excludeFromContext"], "$.payload.excludeFromContext", issues)
      return
    case "ui.respond":
      exactKeys(input, ["requestId", "value"], "$.payload", issues)
      nonEmptyString(input["requestId"], "$.payload.requestId", issues)
      if (!("value" in input)) issue(issues, "$.payload.value", "is required")
      else if (!isJsonValue(input["value"])) issue(issues, "$.payload.value", "must be a JSON value")
      return
  }
}

function validatePi(input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.pi", issues)) return
  exactKeys(input, ["sessionId", "sessionFile", "leafId"], "$.pi", issues)
  optional(input, "sessionId", (value) => nonEmptyString(value, "$.pi.sessionId", issues))
  optional(input, "sessionFile", (value) => nonEmptyString(value, "$.pi.sessionFile", issues))
  optional(input, "leafId", (value) => nonEmptyString(value, "$.pi.leafId", issues))
}

function validateModel(input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.model", issues)) return
  exactKeys(input, ["provider", "id", "label", "thinkingLevel"], "$.model", issues)
  optional(input, "provider", (value) => nonEmptyString(value, "$.model.provider", issues))
  optional(input, "id", (value) => nonEmptyString(value, "$.model.id", issues))
  stringValue(input["label"], "$.model.label", issues)
  optional(input, "thinkingLevel", (value) => nonEmptyString(value, "$.model.thinkingLevel", issues))
}

function validateContext(input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.context", issues)) return
  exactKeys(input, ["usedPercent", "remainingPercent", "windowTokens"], "$.context", issues)
  optional(input, "usedPercent", (value) => percentage(value, "$.context.usedPercent", issues))
  optional(input, "remainingPercent", (value) => percentage(value, "$.context.remainingPercent", issues))
  optional(input, "windowTokens", (value) => nonNegativeInteger(value, "$.context.windowTokens", issues))
}

function validateCache(input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.cache", issues)) return
  exactKeys(input, ["policy", "hitPercent", "expiresAt", "expired"], "$.cache", issues)
  optional(input, "policy", (value) => nonEmptyString(value, "$.cache.policy", issues))
  optional(input, "hitPercent", (value) => percentage(value, "$.cache.hitPercent", issues))
  optional(input, "expiresAt", (value) => isoDate(value, "$.cache.expiresAt", issues))
  booleanValue(input["expired"], "$.cache.expired", issues)
}

function validateBackground(input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.background", issues)) return
  exactKeys(input, ["activeCount", "labels"], "$.background", issues)
  nonNegativeInteger(input["activeCount"], "$.background.activeCount", issues)
  stringArray(input["labels"], "$.background.labels", issues)
}

function validateTeams(input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.teams", issues)) return
  exactKeys(input, ["activeRunCount", "runningMemberCount", "failedMemberCount"], "$.teams", issues)
  nonNegativeInteger(input["activeRunCount"], "$.teams.activeRunCount", issues)
  nonNegativeInteger(input["runningMemberCount"], "$.teams.runningMemberCount", issues)
  nonNegativeInteger(input["failedMemberCount"], "$.teams.failedMemberCount", issues)
}

function validateBuild(input: unknown, issues: ValidationIssue[]): void {
  if (!record(input, "$.build", issues)) return
  exactKeys(input, ["rubatoCommit", "piVersion", "remoteProtocolMin", "remoteProtocolMax"], "$.build", issues)
  optional(input, "rubatoCommit", (value) => nonEmptyString(value, "$.build.rubatoCommit", issues))
  nonEmptyString(input["piVersion"], "$.build.piVersion", issues)
  positiveInteger(input["remoteProtocolMin"], "$.build.remoteProtocolMin", issues)
  positiveInteger(input["remoteProtocolMax"], "$.build.remoteProtocolMax", issues)
  if (
    typeof input["remoteProtocolMin"] === "number" &&
    typeof input["remoteProtocolMax"] === "number" &&
    input["remoteProtocolMin"] > input["remoteProtocolMax"]
  ) {
    issue(issues, "$.build.remoteProtocolMin", "must not exceed remoteProtocolMax")
  }
  if (
    typeof input["remoteProtocolMin"] === "number" &&
    typeof input["remoteProtocolMax"] === "number" &&
    input["remoteProtocolMax"] - input["remoteProtocolMin"] > 1
  ) {
    issue(issues, "$.build", "must advertise only protocol N and N-1")
  }
}

function schema<T>(validator: (input: unknown) => ValidationResult<T>): ProtocolSchema<T> {
  return Object.freeze({
    safeParse: validator,
    parse: (input: unknown): T => {
      const result = validator(input)
      if (!result.ok) throw new ProtocolValidationError(result.issues)
      return result.value
    },
  })
}

function finish<T>(value: T, issues: readonly ValidationIssue[]): ValidationResult<T> {
  return issues.length === 0 ? { ok: true, value } : failure(issues)
}

function failure(issues: readonly ValidationIssue[]): ValidationResult<never> {
  return { ok: false, issues }
}

function issue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message })
}

function record(value: unknown, path: string, issues: ValidationIssue[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue(issues, path, "must be an object")
    return false
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    issue(issues, path, "must be a plain object")
    return false
  }
  return true
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issue(issues, `${path}.${key}`, "is not allowed")
  }
}

function optional(
  value: Record<string, unknown>,
  key: string,
  validate: (member: unknown) => void,
): void {
  if (key in value) validate(value[key])
}

function literal<const T extends string | number>(
  value: unknown,
  expected: T,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value !== expected) issue(issues, path, `must equal ${JSON.stringify(expected)}`)
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  expected: T,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string" || !includes(expected, value)) {
    issue(issues, path, `must be one of ${expected.join(", ")}`)
  }
}

function includes<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.some((candidate) => candidate === value)
}

function stringValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string") issue(issues, path, "must be a string")
}

function nonEmptyString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || value.length === 0) issue(issues, path, "must be a non-empty string")
}

function booleanValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "boolean") issue(issues, path, "must be a boolean")
}

function positiveInteger(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) issue(issues, path, "must be a positive integer")
}

function nonNegativeInteger(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) issue(issues, path, "must be a non-negative integer")
}

function percentage(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    issue(issues, path, "must be a number from 0 through 100")
  }
}

function uuid(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isUuid(value)) issue(issues, path, "must be a UUID")
}

function uuidV7(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isUuidV7(value)) issue(issues, path, "must be a UUIDv7")
}

function isoDate(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    issue(issues, path, "must be an ISO-8601 timestamp")
  }
}

function stringArray(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array")
    return
  }
  value.forEach((member, index) => stringValue(member, `${path}[${index}]`, issues))
}

function jsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  let valid: boolean
  if (Array.isArray(value)) {
    valid = value.every((member) => jsonValue(member, ancestors))
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown
    valid =
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every((member) => jsonValue(member, ancestors))
  }
  ancestors.delete(value)
  return valid
}
