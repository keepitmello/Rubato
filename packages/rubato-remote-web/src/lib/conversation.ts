import type { EventEnvelope, JsonValue } from "@rubato/remote-protocol"
import type { ConversationEntry, ConversationState, SessionSnapshot, UiRequest } from "./types"

const MAX_RENDERED_ENTRIES = 1_000
const text = (value: JsonValue | undefined): string | undefined => typeof value === "string" ? value : undefined

function bounded(entries: readonly ConversationEntry[]): readonly ConversationEntry[] {
  return entries.length > MAX_RENDERED_ENTRIES ? entries.slice(-MAX_RENDERED_ENTRIES) : entries
}

function uiRequest(payload: EventEnvelope["payload"]): UiRequest | undefined {
  const requestId = text(payload.requestId)
  const kind = payload.kind
  const title = text(payload.title)
  if (!requestId || !title || (kind !== "select" && kind !== "confirm" && kind !== "input")) return undefined
  const options = Array.isArray(payload.options) ? payload.options.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return []
    const value = option as Record<string, JsonValue>
    const label = text(value.label)
    const optionValue = text(value.value)
    return label && optionValue ? [{ label, value: optionValue }] : []
  }) : undefined
  if (kind === "select") return { requestId, kind, title, options: options ?? [] }
  if (kind === "confirm") return { requestId, kind, title, ...(text(payload.message) ? { message: text(payload.message)! } : {}) }
  return { requestId, kind, title, ...(text(payload.placeholder) ? { placeholder: text(payload.placeholder)! } : {}) }
}

function bufferEvent(events: readonly EventEnvelope[], event: EventEnvelope): readonly EventEnvelope[] {
  if (events.some((candidate) => candidate.seq === event.seq)) return events
  return [...events, event].sort((left, right) => left.seq - right.seq)
}

export function applyConversationSnapshot(snapshot: SessionSnapshot, previous?: ConversationState): ConversationState {
  if (previous?.snapshotInstalled && snapshot.lastSeq < previous.lastSeq) {
    return previous.requiresSnapshot ? { ...previous, recoveryVersion: previous.recoveryVersion + 1 } : previous
  }
  const bufferedEvents = previous?.bufferedEvents.filter((event) => event.seq > snapshot.lastSeq) ?? []
  let restored: ConversationState = {
    entries: bounded(snapshot.entries),
    lastSeq: snapshot.lastSeq,
    requiresSnapshot: false,
    snapshotInstalled: true,
    recoveryVersion: previous?.recoveryVersion ?? 0,
    bufferedEvents: [],
    ...(snapshot.uiRequest ? { uiRequest: snapshot.uiRequest } : {}),
  }
  for (const event of bufferedEvents) restored = reduceConversation(restored, event)
  return restored
}

export function reduceConversation(state: ConversationState, event: EventEnvelope): ConversationState {
  if (!state.snapshotInstalled || state.requiresSnapshot) {
    const bufferedEvents = event.seq <= state.lastSeq ? state.bufferedEvents : bufferEvent(state.bufferedEvents, event)
    return bufferedEvents === state.bufferedEvents ? state : { ...state, bufferedEvents }
  }
  if (event.seq <= state.lastSeq) return state
  if (event.seq !== state.lastSeq + 1) return { ...state, requiresSnapshot: true, recoveryVersion: state.recoveryVersion + 1, bufferedEvents: bufferEvent(state.bufferedEvents, event) }
  const payload = event.payload
  const id = text(payload.ephemeralMessageId) ?? text(payload.messageId) ?? `event-${event.seq}`
  let entries = state.entries

  switch (event.type) {
    case "message.start": {
      const role = payload.role === "user" ? "user" : "assistant"
      entries = [...entries, { id, kind: "message", role, text: text(payload.text) ?? "", streaming: true, at: event.at }]
      break
    }
    case "message.delta": {
      const delta = text(payload.delta) ?? ""
      const index = entries.findIndex((entry) => entry.id === id && entry.kind === "message")
      entries = index < 0
        ? [...entries, { id, kind: "message", role: "assistant", text: delta, streaming: true }]
        : entries.map((entry, position) => position === index && entry.kind === "message" ? { ...entry, text: entry.text + delta } : entry)
      break
    }
    case "message.commit":
      entries = entries.map((entry) => entry.id === id && entry.kind === "message" ? { ...entry, text: text(payload.text) ?? entry.text, streaming: false } : entry)
      break
    case "tool.start":
      entries = [...entries, { id, kind: "tool", name: text(payload.name) ?? "도구", summary: text(payload.summary) ?? "실행 중", status: "running" }]
      break
    case "tool.update":
    case "tool.end":
      entries = entries.map((entry) => entry.id === id && entry.kind === "tool" ? {
        ...entry,
        summary: text(payload.summary) ?? entry.summary,
        ...(text(payload.output) ?? entry.output ? { output: (text(payload.output) ?? entry.output)! } : {}),
        ...(text(payload.artifactId) ?? entry.artifactId ? { artifactId: (text(payload.artifactId) ?? entry.artifactId)! } : {}),
        status: event.type === "tool.end" ? (payload.failed === true ? "failed" : "done") : entry.status,
      } : entry)
      break
    case "snapshot.required":
      return { ...state, requiresSnapshot: true, recoveryVersion: state.recoveryVersion + 1 }
    case "ui.request": {
      const request = uiRequest(payload)
      if (request) return { ...state, lastSeq: event.seq, uiRequest: request }
      break
    }
    case "ui.dismiss":
      return { ...state, lastSeq: event.seq, uiRequest: undefined }
    case "compaction.start":
      entries = [...entries, { id, kind: "notice", text: "대화를 정리하고 있어요." }]
      break
    case "compaction.end":
      entries = [...entries, { id, kind: "notice", text: "대화 정리가 끝났어요." }]
      break
  }
  return { ...state, entries: bounded(entries), lastSeq: event.seq }
}

export class DeltaBatcher {
  private queued: EventEnvelope[] = []
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly flushEvents: (events: readonly EventEnvelope[]) => void) {}

  push(event: EventEnvelope): void {
    this.queued.push(event)
    this.bytes += JSON.stringify(event.payload).length
    if (this.bytes >= 4 * 1024) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), 50)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.queued.length === 0) return
    const events = this.queued
    this.queued = []
    this.bytes = 0
    this.flushEvents(events)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.queued = []
    this.bytes = 0
  }
}
