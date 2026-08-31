import { describe, expect, test } from "bun:test"
import {
  FINAL_RESPONSE_PREVIEW_MAX_CHARS,
  PENDING_INPUT_PREVIEW_MAX_CHARS,
  REMOTE_PROTOCOL_CURRENT_VERSION,
  REMOTE_PROTOCOL_MIN_VERSION,
  liveSessionSummarySchema,
  messagePageResponseSchema,
  parseRequestedProtocolVersion,
  previewFinalResponse,
  previewPendingInput,
  projectLiveSessionSummary,
  projectMessagePage,
  projectSessionSnapshot,
  projectSnapshotResponse,
  snapshotResponseSchema,
  type ConversationEntry,
  type LiveSessionSummary,
  type MessagePageResponse,
  type SessionSnapshot,
  type SnapshotResponse,
} from "../src/index.js"

const HOST_ID = "018f0c7a-2f3b-7c4d-8e5f-1234567890ab"
const LIVE_ID = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab"

const fixtures = {
  summary: new URL("./fixtures/live-session-summary.v1.json", import.meta.url),
  snapshot: new URL("./fixtures/session-snapshot.v1.json", import.meta.url),
}

async function load(name: keyof typeof fixtures): Promise<unknown> {
  return Bun.file(fixtures[name]).json()
}

const timeline = {
  schemaVersion: 1 as const,
  runs: [{
    id: "legacy:entry-2",
    status: "completed" as const,
    rootUserMessageId: "m1",
    startedAt: "2026-08-31T00:59:20.000Z",
    completedAt: "2026-08-31T01:00:00.000Z",
    finalMessageId: "m2",
    lastProgressPreview: "Checking rooms",
    progressMessageCount: 1,
    toolCount: 1,
    failedToolCount: 0,
    steeringCount: 0,
  }],
  activeRequestRunId: "legacy:entry-2",
  pendingInputs: [{
    id: "input-1",
    delivery: "followUp" as const,
    textPreview: "then verify",
    textLength: 11,
    imageCount: 0,
    enqueuedAt: "2026-08-31T01:00:01.000Z",
    source: "remote" as const,
  }],
  hasOlder: true,
}

const presentation = {
  schemaVersion: 1 as const,
  lastFinalResponsePreview: "Accessibility checks passed.",
  lastFinalResponseAt: "2026-08-31T01:00:00.000Z",
  pendingFollowUpCount: 1,
  pendingSteerCount: 0,
}

describe("protocol version query", () => {
  test("treats a missing version as 1 and rejects unsupported values", () => {
    expect(parseRequestedProtocolVersion(undefined)).toBe(1)
    expect(parseRequestedProtocolVersion("")).toBe(1)
    expect(parseRequestedProtocolVersion("1")).toBe(1)
    expect(parseRequestedProtocolVersion("2")).toBe(2)
    expect(parseRequestedProtocolVersion("3")).toBe("protocol_mismatch")
    expect(parseRequestedProtocolVersion("0")).toBe("protocol_mismatch")
    expect(parseRequestedProtocolVersion("2.0")).toBe("protocol_mismatch")
  })
})

describe("v1 and v2 projection", () => {
  test("keeps published v1 fixtures exact after a v1 projection", async () => {
    const summary = (await load("summary")) as LiveSessionSummary
    const snapshot = (await load("snapshot")) as SessionSnapshot
    expect(liveSessionSummarySchema.safeParse(summary).ok).toBe(true)
    expect(projectLiveSessionSummary(summary, 1)).toEqual(summary)
    expect(projectSessionSnapshot(snapshot, 1)).toEqual(snapshot)
    expect(REMOTE_PROTOCOL_CURRENT_VERSION).toBe(2)
    expect(REMOTE_PROTOCOL_MIN_VERSION).toBe(1)
  })

  test("strips v2 presentation, timeline, and entry fields for v1 clients", async () => {
    const summary = { ...(await load("summary")) as LiveSessionSummary, presentation }
    const v2Entry: ConversationEntry = {
      id: "m1",
      kind: "message",
      role: "assistant",
      text: "Done.",
      at: "2026-08-31T01:00:00.000Z",
      requestRunId: "legacy:entry-2",
      phase: "final",
    }
    const thinking: ConversationEntry = { id: "think-1", kind: "thinking", text: "hidden chain" }
    const snapshot: SessionSnapshot = {
      ...(await load("snapshot")) as SessionSnapshot,
      summary,
      state: {
        ...((await load("snapshot")) as SessionSnapshot).state,
        entries: [v2Entry, thinking, {
          id: "tool1",
          kind: "tool",
          name: "test",
          summary: "4 passed",
          status: "done",
          requestRunId: "legacy:entry-2",
          at: "2026-08-31T00:59:40.000Z",
          completedAt: "2026-08-31T00:59:50.000Z",
        }],
        timeline,
      },
    }

    const projectedSummary = projectLiveSessionSummary(summary, 1)
    expect(projectedSummary).not.toHaveProperty("presentation")
    expect(liveSessionSummarySchema.safeParse(projectedSummary).ok).toBe(true)

    const projectedSnapshot = projectSessionSnapshot(snapshot, 1)
    expect(projectedSnapshot.summary).not.toHaveProperty("presentation")
    expect(projectedSnapshot.state).not.toHaveProperty("timeline")
    expect(projectedSnapshot.state.entries.some((entry) => entry.kind === "thinking")).toBe(false)
    expect(projectedSnapshot.state.entries[0]).toEqual({
      id: "m1",
      kind: "message",
      role: "assistant",
      text: "Done.",
      at: "2026-08-31T01:00:00.000Z",
    })
    expect(projectedSnapshot.state.entries[1]).toEqual({
      id: "tool1",
      kind: "tool",
      name: "test",
      summary: "4 passed",
      status: "done",
    })

    const response: SnapshotResponse = {
      summary,
      revision: 9,
      lastSeq: 18,
      entries: snapshot.state.entries,
      tree: snapshot.state.tree,
      commands: snapshot.state.commands,
      timeline,
    }
    const projectedResponse = projectSnapshotResponse(response, 1)
    expect(projectedResponse).not.toHaveProperty("timeline")
    expect(snapshotResponseSchema.safeParse(projectedResponse).ok).toBe(true)

    const page: MessagePageResponse = {
      entries: snapshot.state.entries,
      requestRuns: timeline.runs,
      nextBefore: "m0",
    }
    const projectedPage = projectMessagePage(page, 1)
    expect(projectedPage).not.toHaveProperty("requestRuns")
    expect(messagePageResponseSchema.safeParse(projectedPage).ok).toBe(true)
  })

  test("returns v2 timeline, presentation, and request metadata unchanged", async () => {
    const summary = { ...(await load("summary")) as LiveSessionSummary, presentation }
    const entry: ConversationEntry = {
      id: "m1",
      kind: "message",
      role: "user",
      text: "Check accessibility",
      requestRunId: "legacy:entry-2",
      inputId: "legacy:entry-2",
      delivery: "submit",
    }
    const snapshot: SessionSnapshot = {
      ...(await load("snapshot")) as SessionSnapshot,
      summary,
      state: { ...((await load("snapshot")) as SessionSnapshot).state, entries: [entry], timeline },
    }
    expect(projectLiveSessionSummary(summary, 2).presentation).toEqual(presentation)
    expect(projectSessionSnapshot(snapshot, 2).state.timeline).toEqual(timeline)
    expect(projectSessionSnapshot(snapshot, 2).state.entries[0]).toEqual(entry)
    expect(projectMessagePage({ entries: [entry], requestRuns: timeline.runs }, 2).requestRuns).toEqual(timeline.runs)
  })

  test("never puts thinking text on the projected wire", () => {
    const entries: ConversationEntry[] = [
      { id: "think-1", kind: "thinking", text: "secret scratchpad" },
      { id: "m1", kind: "message", role: "assistant", text: "Visible", phase: "final", requestRunId: "run-1" },
    ]
    expect(projectMessagePage({ entries }, 1).entries).toEqual([
      { id: "m1", kind: "message", role: "assistant", text: "Visible" },
    ])
    expect(projectMessagePage({ entries }, 2).entries).toEqual([
      { id: "m1", kind: "message", role: "assistant", text: "Visible", phase: "final", requestRunId: "run-1" },
    ])
  })
})

describe("preview helpers", () => {
  test("builds a 240-character final preview and a 500-character pending preview", () => {
    const final = previewFinalResponse("# Title\n- item\n[label](https://example.com)\n`code`\n```ts\nsecret\n```\n" + "x".repeat(300))
    expect(final).toBeDefined()
    expect([...final!].length).toBeLessThanOrEqual(FINAL_RESPONSE_PREVIEW_MAX_CHARS)
    expect(final).toContain("Title")
    expect(final).toContain("label")
    expect(final).toContain("code")
    expect(final).not.toContain("https://example.com")
    expect(previewFinalResponse("   \n")).toBeUndefined()

    const pending = previewPendingInput(`${"word ".repeat(200)}\n\nextra`)
    expect([...pending].length).toBe(PENDING_INPUT_PREVIEW_MAX_CHARS)
    expect(pending.includes("\n")).toBe(false)
  })
})
