import canonicalEvent from "../../../rubato-remote-protocol/test/fixtures/event-envelope.v1.json"
import { eventEnvelopeSchema } from "@rubato/remote-protocol"
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
})
