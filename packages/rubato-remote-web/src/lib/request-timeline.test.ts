import type { ConversationEntry, RequestTimelineSnapshot } from "@rubato/remote-protocol"
import { visibleConversationItems } from "./request-timeline"

type MessageEntry = Extract<ConversationEntry, { kind: "message" }>

function user(id: string, text: string, extra: Partial<MessageEntry> = {}): MessageEntry {
  return { id, kind: "message", role: "user", text, ...extra }
}

function assistant(id: string, text: string, extra: Partial<MessageEntry> = {}): MessageEntry {
  return { id, kind: "message", role: "assistant", text, ...extra }
}

function timeline(activeRequestRunId: string): RequestTimelineSnapshot {
  return {
    schemaVersion: 1,
    runs: [],
    activeRequestRunId,
    pendingInputs: [],
    hasOlder: false,
  }
}

describe("visibleConversationItems", () => {
  test("keeps every assistant text visible while a request-run is live", () => {
    const entries = [
      user("u1", "fix the build", { requestRunId: "run-1" }),
      assistant("a1", "checking", { requestRunId: "run-1", phase: "progress" }),
      assistant("a2", "still looking", { requestRunId: "run-1", phase: "progress", streaming: true }),
    ]
    expect(visibleConversationItems(entries, { activeRequestRunId: "run-1" })).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "message", entry: entries[1] },
      { kind: "message", entry: entries[2] },
    ])
    expect(visibleConversationItems(entries, { timeline: timeline("run-1") })).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "message", entry: entries[1] },
      { kind: "message", entry: entries[2] },
    ])
  })

  test("collapses completed intermediate assistant texts and keeps the final bubble", () => {
    const entries = [
      user("u1", "fix the build", { requestRunId: "run-1" }),
      assistant("a1", "checking", { requestRunId: "run-1", phase: "progress" }),
      assistant("a2", "found it", { requestRunId: "run-1", phase: "progress" }),
      assistant("a3", "patched", { requestRunId: "run-1", phase: "final" }),
    ]
    expect(visibleConversationItems(entries)).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "collapsed-progress", runId: "run-1", entries: [entries[1], entries[2]] },
      { kind: "message", entry: entries[3] },
    ])
  })

  test("keeps steer user messages visible inside a collapsed run", () => {
    const entries = [
      user("u1", "fix the build", { requestRunId: "run-1" }),
      assistant("a1", "checking", { requestRunId: "run-1", phase: "progress" }),
      user("u2", "also tests", { requestRunId: "run-1", delivery: "steer" }),
      assistant("a2", "patched", { requestRunId: "run-1", phase: "final" }),
    ]
    expect(visibleConversationItems(entries)).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "collapsed-progress", runId: "run-1", entries: [entries[1]] },
      { kind: "message", entry: entries[2] },
      { kind: "message", entry: entries[3] },
    ])
  })

  test("groups legacy messages from a non-steer user until the next non-steer user", () => {
    const entries = [
      user("u1", "first"),
      assistant("a1", "thinking"),
      assistant("a2", "done"),
      user("u2", "steer it", { delivery: "steer" }),
      assistant("a3", "steered"),
      user("u3", "second"),
      assistant("a4", "next"),
    ]
    expect(visibleConversationItems(entries)).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "collapsed-progress", runId: "legacy:u1", entries: [entries[1], entries[2]] },
      { kind: "message", entry: entries[3] },
      { kind: "message", entry: entries[4] },
      { kind: "message", entry: entries[5] },
      { kind: "message", entry: entries[6] },
    ])
  })

  test("does not fabricate a final assistant message when a run is only progress", () => {
    const entries = [
      user("u1", "fix the build", { requestRunId: "run-1" }),
      assistant("a1", "checking", { requestRunId: "run-1", phase: "progress" }),
      assistant("a2", "still looking", { requestRunId: "run-1", phase: "progress" }),
    ]
    expect(visibleConversationItems(entries)).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "collapsed-progress", runId: "run-1", entries: [entries[1], entries[2]] },
    ])
  })

  test("skips tool, thinking, notice, and image entries", () => {
    const entries: ConversationEntry[] = [
      user("u1", "fix the build", { requestRunId: "run-1" }),
      { id: "t1", kind: "thinking", text: "hidden chain" },
      { id: "tool-1", kind: "tool", name: "test", summary: "running", status: "running", requestRunId: "run-1" },
      assistant("a1", "checking", { requestRunId: "run-1", phase: "progress" }),
      { id: "n1", kind: "notice", text: "compacted", requestRunId: "run-1" },
      assistant("a2", "patched", { requestRunId: "run-1", phase: "final" }),
      { id: "img-1", kind: "image", alt: "diff", url: "https://example.test/diff.png", requestRunId: "run-1" },
    ]
    expect(visibleConversationItems(entries)).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "collapsed-progress", runId: "run-1", entries: [entries[3]] },
      { kind: "message", entry: entries[5] },
    ])
  })

  test("collapses committed assistants without phase unless the run is still live", () => {
    const entries = [
      user("u1", "fix the build", { requestRunId: "run-1" }),
      assistant("a1", "checking", { requestRunId: "run-1" }),
      assistant("a2", "still looking", { requestRunId: "run-1" }),
    ]
    expect(visibleConversationItems(entries)).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "collapsed-progress", runId: "run-1", entries: [entries[1]] },
      { kind: "message", entry: entries[2] },
    ])
    expect(visibleConversationItems(entries, { working: true })).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "message", entry: entries[1] },
      { kind: "message", entry: entries[2] },
    ])
  })

  test("expands the last run while working even without an active id", () => {
    const entries = [
      user("u1", "first", { requestRunId: "run-1" }),
      assistant("a1", "old", { requestRunId: "run-1", phase: "final" }),
      user("u2", "now", { requestRunId: "run-2" }),
      assistant("a2", "checking", { requestRunId: "run-2", phase: "progress" }),
    ]
    expect(visibleConversationItems(entries, { working: true })).toEqual([
      { kind: "message", entry: entries[0] },
      { kind: "message", entry: entries[1] },
      { kind: "message", entry: entries[2] },
      { kind: "message", entry: entries[3] },
    ])
  })
})
