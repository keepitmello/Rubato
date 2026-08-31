import { describe, expect, test } from "bun:test"
import {
  REMOTE_ACTION_TYPES,
  REMOTE_ERROR_CODES,
  REMOTE_EVENT_TYPES,
  REMOTE_PROTOCOL_NAME,
  actionRequestSchema,
  clientResumeSchema,
  eventEnvelopeSchema,
  isUuid,
  isUuidV7,
  liveSessionSummarySchema,
  remoteErrorResponseSchema,
  zmxNameForLiveSession,
} from "../src/index.js"

const HOST_ID = "018f0c7a-2f3b-7c4d-8e5f-1234567890ab"
const LIVE_ID = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab"
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000"

const fixtures = {
  action: new URL("./fixtures/action-request.v1.json", import.meta.url),
  event: new URL("./fixtures/event-envelope.v1.json", import.meta.url),
  resume: new URL("./fixtures/client-resume.v1.json", import.meta.url),
  summary: new URL("./fixtures/live-session-summary.v1.json", import.meta.url),
}

async function fixture(name: keyof typeof fixtures): Promise<unknown> {
  return Bun.file(fixtures[name]).json()
}

describe("published protocol fixtures", () => {
  test("validate as strict v1 contracts", async () => {
    expect(actionRequestSchema.safeParse(await fixture("action")).ok).toBe(true)
    expect(eventEnvelopeSchema.safeParse(await fixture("event")).ok).toBe(true)
    expect(clientResumeSchema.safeParse(await fixture("resume")).ok).toBe(true)
    expect(liveSessionSummarySchema.safeParse(await fixture("summary")).ok).toBe(true)
  })
})

describe("identifiers", () => {
  test("distinguishes UUIDs from installation/process UUIDv7 identifiers", () => {
    expect(isUuid(REQUEST_ID)).toBe(true)
    expect(isUuidV7(REQUEST_ID)).toBe(false)
    expect(isUuidV7(HOST_ID)).toBe(true)
    expect(isUuidV7(LIVE_ID)).toBe(true)
    expect(zmxNameForLiveSession(LIVE_ID)).toBe("rubato-018f0c7b2f3b")
    expect(() => zmxNameForLiveSession(REQUEST_ID)).toThrow("UUIDv7")
  })
})

describe("action request validation", () => {
  const payloads: Record<(typeof REMOTE_ACTION_TYPES)[number], Record<string, unknown>> = {
    "input.submit": { text: "hello", delivery: "auto" },
    "input.steer": { text: "adjust" },
    "input.followUp": { text: "then verify" },
    "agent.abort": {},
    "session.compact": { instructions: "retain decisions" },
    "session.navigate": { targetEntryId: "entry-2", summarize: true },
    "session.fork": {},
    "session.new": {},
    "session.reload": {},
    "session.rename": { name: "Protocol work" },
    "model.set": { provider: "openai", modelId: "gpt-5.6" },
    "thinking.set": { level: "high" },
    "bash.execute": { command: "pwd", excludeFromContext: false },
    "bash.abort": {},
    "ui.respond": { requestId: "ui-1", value: { selected: "first" } },
    "environment.refresh": {},
  }

  test("accepts every specified action and its exact payload", () => {
    for (const action of REMOTE_ACTION_TYPES) {
      expect(
        actionRequestSchema.safeParse({
          protocol: REMOTE_PROTOCOL_NAME,
          requestId: REQUEST_ID,
          hostId: HOST_ID,
          liveSessionId: LIVE_ID,
          action,
          payload: payloads[action],
        }).ok,
      ).toBe(true)
    }
  })

  test("rejects unknown envelope and payload fields", () => {
    const envelope = {
      protocol: REMOTE_PROTOCOL_NAME,
      requestId: REQUEST_ID,
      hostId: HOST_ID,
      liveSessionId: LIVE_ID,
      action: "agent.abort",
      payload: { unexpected: true },
      unexpected: true,
    }
    const result = actionRequestSchema.safeParse(envelope)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((entry) => entry.path)).toEqual(["$.unexpected", "$.payload.unexpected"])
  })

  test("rejects stale shapes before dispatch", () => {
    expect(
      actionRequestSchema.safeParse({
        protocol: REMOTE_PROTOCOL_NAME,
        requestId: REQUEST_ID,
        hostId: HOST_ID,
        liveSessionId: LIVE_ID,
        action: "session.navigate",
        expectedRevision: -1,
        payload: { targetEntryId: "" },
      }).ok,
    ).toBe(false)
  })
})

describe("event, summary, and error validation", () => {
  test("recognizes every event and error code constant", () => {
    for (const type of REMOTE_EVENT_TYPES) {
      expect(
        eventEnvelopeSchema.safeParse({
          protocol: REMOTE_PROTOCOL_NAME,
          hostId: HOST_ID,
          liveSessionId: LIVE_ID,
          seq: 1,
          at: "2026-08-31T01:00:00.000Z",
          type,
          payload: {},
        }).ok,
      ).toBe(true)
    }
    for (const code of REMOTE_ERROR_CODES) {
      expect(remoteErrorResponseSchema.safeParse({ error: { code, message: "Request failed.", traceId: "trace-1" } }).ok).toBe(true)
    }
  })

  test("rejects unknown event types, non-JSON payloads, and leaked error fields", () => {
    expect(
      eventEnvelopeSchema.safeParse({
        protocol: REMOTE_PROTOCOL_NAME,
        hostId: HOST_ID,
        liveSessionId: LIVE_ID,
        seq: 1,
        at: "2026-08-31T01:00:00.000Z",
        type: "message.unknown",
        payload: { value: Number.NaN },
      }).ok,
    ).toBe(false)
    expect(
      remoteErrorResponseSchema.safeParse({
        error: { code: "internal_error", message: "Request failed.", traceId: "trace-1", stack: "hidden" },
      }).ok,
    ).toBe(false)
  })

  test("enforces UUIDv7 identity, zmx derivation, timestamps, percentages, and N/N-1 build ranges", async () => {
    const summary = (await fixture("summary")) as Record<string, unknown>
    const invalid = structuredClone(summary) as Record<string, unknown>
    invalid["zmxName"] = "rubato-aaaaaaaaaaaa"
    ;(invalid["context"] as Record<string, unknown>)["usedPercent"] = 101
    ;(invalid["build"] as Record<string, unknown>)["remoteProtocolMax"] = 3
    invalid["createdAt"] = "yesterday"

    const result = liveSessionSummarySchema.safeParse(invalid)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map((entry) => entry.path)).toEqual([
        "$.zmxName",
        "$.createdAt",
        "$.context.usedPercent",
        "$.build",
      ])
    }
  })
})
