import canonicalEvent from "../../../rubato-remote-protocol/test/fixtures/event-envelope.v1.json"
import { eventEnvelopeSchema, snapshotResponseSchema } from "@rubato/remote-protocol"
import { fixtureSnapshot } from "./fixtures"
import { applyConversationSnapshot, DeltaBatcher, reduceConversation } from "./conversation"
import type { ConversationState } from "./types"

const initial: ConversationState = { entries: [], lastSeq: 0, requiresSnapshot: false, snapshotInstalled: true, recoveryVersion: 0, bufferedEvents: [] }
const awaitingSnapshot: ConversationState = { ...initial, snapshotInstalled: false }

describe("conversation events", () => {
  test("consumes the canonical protocol fixture without recreating its contract", () => {
    const event = eventEnvelopeSchema.parse(canonicalEvent)
    const state = reduceConversation({ ...initial, lastSeq: event.seq - 1 }, event)
    expect(state.entries).toEqual([{ id: "message-1", kind: "message", role: "assistant", text: "Focused tests are running.", streaming: true }])
    expect(state.lastSeq).toBe(1828)
  })

  test("renders real Pi nested message events with stable ids and cumulative updates", () => {
    const base = { ...canonicalEvent, hostId: fixtureSnapshot.summary.hostId, liveSessionId: fixtureSnapshot.summary.liveSessionId }
    const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1_788_147_096_682 })
    let state = reduceConversation(initial, eventEnvelopeSchema.parse({ ...base, seq: 1, type: "message.start", payload: { event: { type: "message_start", message: message("") } } }))
    state = reduceConversation(state, eventEnvelopeSchema.parse({ ...base, seq: 2, type: "message.delta", payload: { event: { type: "message_update", message: message("REMOTE") } } }))
    state = reduceConversation(state, eventEnvelopeSchema.parse({ ...base, seq: 3, type: "message.delta", payload: { event: { type: "message_update", message: message("REMOTE_SMOKE_OK") } } }))
    state = reduceConversation(state, eventEnvelopeSchema.parse({ ...base, seq: 4, type: "message.commit", payload: { event: { type: "message_end", message: message("REMOTE_SMOKE_OK") } } }))
    expect(state.entries).toEqual([{ id: "pi-message-1788147096682", kind: "message", role: "assistant", text: "REMOTE_SMOKE_OK", streaming: false, at: canonicalEvent.at }])
  })

  test("deduplicates replayed events and requests a snapshot for a sequence gap", () => {
    const event = eventEnvelopeSchema.parse(canonicalEvent)
    const state = reduceConversation({ ...initial, lastSeq: event.seq - 1 }, event)
    expect(reduceConversation(state, event)).toBe(state)
    const gap = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 1830, payload: { ephemeralMessageId: "message-1", delta: " missed" } })
    expect(reduceConversation(state, gap)).toMatchObject({ lastSeq: 1828, requiresSnapshot: true })
  })

  test("replays frames captured before the initial snapshot and after a gap snapshot", () => {
    const beforeSnapshot = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 11, payload: { ephemeralMessageId: "message-live", delta: " + before" } })
    const captured = reduceConversation(awaitingSnapshot, beforeSnapshot)
    expect(captured.bufferedEvents).toEqual([beforeSnapshot])
    const installed = applyConversationSnapshot({ ...fixtureSnapshot, lastSeq: 10, entries: [{ id: "message-live", kind: "message", role: "assistant", text: "authoritative", streaming: true }] }, captured)
    expect(installed).toMatchObject({ lastSeq: 11, requiresSnapshot: false, bufferedEvents: [] })
    expect(installed.entries).toEqual([{ id: "message-live", kind: "message", role: "assistant", text: "authoritative + before", streaming: true }])

    const gapFrame = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 13, payload: { ephemeralMessageId: "message-live", delta: " + after" } })
    const recovering = reduceConversation(installed, gapFrame)
    const recovered = applyConversationSnapshot({ ...fixtureSnapshot, lastSeq: 12, entries: [{ id: "message-live", kind: "message", role: "assistant", text: "new snapshot", streaming: true }] }, recovering)
    expect(recovered).toMatchObject({ lastSeq: 13, requiresSnapshot: false, bufferedEvents: [] })
    expect(recovered.entries).toEqual([{ id: "message-live", kind: "message", role: "assistant", text: "new snapshot + after", streaming: true }])
  })

  test("deduplicates buffered frames already represented by the snapshot", () => {
    const frame = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 12, payload: { ephemeralMessageId: "message-live", delta: " duplicate" } })
    const recovering = reduceConversation(reduceConversation({ ...initial, lastSeq: 10 }, frame), frame)
    expect(recovering.bufferedEvents).toEqual([frame])
    const recovered = applyConversationSnapshot({ ...fixtureSnapshot, lastSeq: 12, entries: [{ id: "message-live", kind: "message", role: "assistant", text: "snapshot owns it", streaming: true }] }, recovering)
    expect(recovered.entries).toEqual([{ id: "message-live", kind: "message", role: "assistant", text: "snapshot owns it", streaming: true }])
    expect(recovered.bufferedEvents).toEqual([])
  })

  test("recovers immediately when a reconnect supplies the missing frame", () => {
    const seq12 = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 12, payload: { ephemeralMessageId: "message-live", delta: " twelve" } })
    const seq11 = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 11, payload: { ephemeralMessageId: "message-live", delta: " eleven" } })
    const recovering = reduceConversation({ ...initial, lastSeq: 10 }, seq12)
    const recovered = reduceConversation(recovering, seq11)
    expect(recovered).toMatchObject({ lastSeq: 12, requiresSnapshot: false, bufferedEvents: [] })
    expect(recovered.entries).toEqual([{ id: "message-live", kind: "message", role: "assistant", text: " eleven twelve", streaming: true }])
  })

  test("detects a second gap during replay and keeps its tail for another snapshot", () => {
    const seq12 = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 12, payload: { ephemeralMessageId: "message-live", delta: " twelve" } })
    const seq14 = eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 14, payload: { ephemeralMessageId: "message-live", delta: " fourteen" } })
    let recovering = reduceConversation({ ...initial, lastSeq: 10 }, seq12)
    recovering = reduceConversation(recovering, seq14)
    const stale = applyConversationSnapshot({ ...fixtureSnapshot, lastSeq: 9, entries: [] }, recovering)
    expect(stale).toMatchObject({ lastSeq: 10, requiresSnapshot: true, recoveryVersion: 2 })
    expect(stale.bufferedEvents).toEqual([seq12, seq14])
    const stillRecovering = applyConversationSnapshot({ ...fixtureSnapshot, lastSeq: 11, entries: [{ id: "message-live", kind: "message", role: "assistant", text: "snapshot", streaming: true }] }, recovering)
    expect(stillRecovering).toMatchObject({ lastSeq: 12, requiresSnapshot: true, recoveryVersion: 2 })
    expect(stillRecovering.bufferedEvents).toEqual([seq14])
    const recovered = applyConversationSnapshot({ ...fixtureSnapshot, lastSeq: 13, entries: [{ id: "message-live", kind: "message", role: "assistant", text: "newer", streaming: true }] }, stillRecovering)
    expect(recovered).toMatchObject({ lastSeq: 14, requiresSnapshot: false, bufferedEvents: [] })
    expect(recovered.entries).toEqual([{ id: "message-live", kind: "message", role: "assistant", text: "newer fourteen", streaming: true }])
  })

  test("surfaces and dismisses structured UI requests", () => {
    const requested = reduceConversation({ ...initial, lastSeq: 30 }, eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 31, type: "ui.request", payload: { requestId: "request-1", kind: "select", title: "어느 파일을 사용할까요?", options: [{ label: "첫 번째", value: "one" }] } }))
    expect(requested.uiRequest).toEqual({ requestId: "request-1", kind: "select", title: "어느 파일을 사용할까요?", options: [{ label: "첫 번째", value: "one" }] })
    const dismissed = reduceConversation(requested, eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 32, type: "ui.dismiss", payload: {} }))
    expect(dismissed.uiRequest).toBeUndefined()
  })

  test("batches deltas at 50ms and flushes large payloads immediately", () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const batcher = new DeltaBatcher(flush)
    const event = eventEnvelopeSchema.parse(canonicalEvent)
    batcher.push(event)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(flush).toHaveBeenCalledWith([event])
    batcher.push(eventEnvelopeSchema.parse({ ...canonicalEvent, seq: 1829, payload: { ephemeralMessageId: "message-1", delta: "x".repeat(4_200) } }))
    expect(flush).toHaveBeenCalledTimes(2)
    batcher.dispose()
    vi.useRealTimers()
  })

  test("preserves requestRunId, phase, and delivery from message.start and message.commit payloads", () => {
    const started = reduceConversation(initial, eventEnvelopeSchema.parse({
      ...canonicalEvent,
      seq: 1,
      type: "message.start",
      payload: { ephemeralMessageId: "message-1", role: "assistant", text: "Working", requestRunId: "run-1", phase: "progress", delivery: "submit" },
    }))
    expect(started.entries).toEqual([{
      id: "message-1", kind: "message", role: "assistant", text: "Working", streaming: true, at: canonicalEvent.at,
      requestRunId: "run-1", phase: "progress", delivery: "submit",
    }])
    const committed = reduceConversation(started, eventEnvelopeSchema.parse({
      ...canonicalEvent,
      seq: 2,
      type: "message.commit",
      payload: { ephemeralMessageId: "message-1", text: "Done", requestRunId: "run-1", phase: "final", delivery: "submit" },
    }))
    expect(committed.entries).toEqual([{
      id: "message-1", kind: "message", role: "assistant", text: "Done", streaming: false, at: canonicalEvent.at,
      requestRunId: "run-1", phase: "final", delivery: "submit",
    }])
  })

  test("preserves request-run fields from nested Pi message events", () => {
    const base = { ...canonicalEvent, hostId: fixtureSnapshot.summary.hostId, liveSessionId: fixtureSnapshot.summary.liveSessionId }
    const message = (text: string, extra: Record<string, unknown> = {}) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: 1_788_147_096_682,
      ...extra,
    })
    let state = reduceConversation(initial, eventEnvelopeSchema.parse({
      ...base,
      seq: 1,
      type: "message.start",
      payload: { requestRunId: "run-9", event: { type: "message_start", message: message("", { phase: "progress", delivery: "followUp" }) } },
    }))
    state = reduceConversation(state, eventEnvelopeSchema.parse({
      ...base,
      seq: 2,
      type: "message.commit",
      payload: { requestRunId: "run-9", event: { type: "message_end", message: message("REMOTE_SMOKE_OK", { phase: "final", delivery: "followUp" }) } },
    }))
    expect(state.entries).toEqual([{
      id: "pi-message-1788147096682",
      kind: "message",
      role: "assistant",
      text: "REMOTE_SMOKE_OK",
      streaming: false,
      at: canonicalEvent.at,
      requestRunId: "run-9",
      phase: "final",
      delivery: "followUp",
    }])
  })

  test("does not invent phase when the event omits it", () => {
    const state = reduceConversation(initial, eventEnvelopeSchema.parse({
      ...canonicalEvent,
      seq: 1,
      type: "message.start",
      payload: { ephemeralMessageId: "message-1", text: "Hi", requestRunId: "run-1" },
    }))
    expect(state.entries).toEqual([{
      id: "message-1", kind: "message", role: "assistant", text: "Hi", streaming: true, at: canonicalEvent.at,
      requestRunId: "run-1",
    }])
  })

  test("copies requestRunId onto tool entries", () => {
    const state = reduceConversation(initial, eventEnvelopeSchema.parse({
      ...canonicalEvent,
      seq: 1,
      type: "tool.start",
      payload: { ephemeralMessageId: "tool-1", name: "read", summary: "읽는 중", requestRunId: "run-1" },
    }))
    expect(state.entries).toEqual([{
      id: "tool-1", kind: "tool", name: "read", summary: "읽는 중", status: "running", requestRunId: "run-1",
    }])
  })

  test("keeps timeline from a parsed snapshot body the way fetchSnapshot now forwards it", () => {
    const timeline = { schemaVersion: 1 as const, runs: [], pendingInputs: [], hasOlder: false }
    const body = snapshotResponseSchema.parse({ ...fixtureSnapshot, timeline })
    expect(body.timeline).toEqual(timeline)
    expect(applyConversationSnapshot(body).timeline).toEqual(timeline)
  })

  test("keeps the previous timeline when a later snapshot omits it", () => {
    const timeline = { schemaVersion: 1 as const, runs: [], pendingInputs: [], hasOlder: false, activeRequestRunId: "run-1" }
    const previous = applyConversationSnapshot(snapshotResponseSchema.parse({ ...fixtureSnapshot, timeline }))
    expect(applyConversationSnapshot(fixtureSnapshot, previous).timeline).toEqual(timeline)
  })

  test("tracks live execution from agent.state so tool gaps do not look idle", () => {
    const started = reduceConversation(initial, eventEnvelopeSchema.parse({
      ...canonicalEvent, seq: 1, type: "agent.state", payload: { execution: "working" },
    }))
    expect(started.execution).toBe("working")
    const settled = reduceConversation(started, eventEnvelopeSchema.parse({
      ...canonicalEvent, seq: 2, type: "agent.state", payload: { execution: "idle" },
    }))
    expect(settled.execution).toBe("idle")
  })

  test("updates timeline.activeRequestRunId from session.changed requestRun payloads", () => {
    const state = reduceConversation(initial, eventEnvelopeSchema.parse({
      ...canonicalEvent,
      seq: 1,
      type: "session.changed",
      payload: { change: "requestRun", activeRequestRunId: "run-1" },
    }))
    expect(state.timeline?.activeRequestRunId).toBe("run-1")
    const cleared = reduceConversation(state, eventEnvelopeSchema.parse({
      ...canonicalEvent,
      seq: 2,
      type: "session.changed",
      payload: { change: "requestRun" },
    }))
    expect(cleared.timeline?.activeRequestRunId).toBeUndefined()
  })
})
