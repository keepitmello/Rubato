import type { AssistantTextPhase, EventEnvelope, JsonValue, LeadExecution, RequestTimelineSnapshot, UserInputDelivery } from "@rubato/remote-protocol"
import type { ConversationEntry, ConversationState, SessionSnapshot, UiRequest } from "./types"

const MAX_RENDERED_ENTRIES = 1_000
const text = (value: JsonValue | undefined): string | undefined => typeof value === "string" ? value : undefined

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined
}

function messageContent(value: JsonValue | undefined): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.map((part) => object(part)).filter((part): part is Record<string, JsonValue> => Boolean(part))
    .filter((part) => part.type === "text").map((part) => text(part.text) ?? "").join("")
}

function piMessage(payload: EventEnvelope["payload"]): { id: string; role: "user" | "assistant"; text: string; hidden: boolean } | undefined {
  const message = object(object(payload.event)?.message)
  if (!message) return undefined
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined
  return {
    id: timestamp === undefined ? "" : `pi-message-${timestamp}`,
    role: message.role === "user" ? "user" : "assistant",
    text: messageContent(message.content),
    hidden: message.display === false || message.role === "custom",
  }
}

function bounded(entries: readonly ConversationEntry[]): readonly ConversationEntry[] {
  return entries.length > MAX_RENDERED_ENTRIES ? entries.slice(-MAX_RENDERED_ENTRIES) : entries
}

function asPhase(value: JsonValue | undefined): AssistantTextPhase | undefined {
  return value === "progress" || value === "final" ? value : undefined
}

function asDelivery(value: JsonValue | undefined): UserInputDelivery | undefined {
  return value === "submit" || value === "steer" || value === "followUp" ? value : undefined
}

function asExecution(value: JsonValue | undefined): LeadExecution | undefined {
  return value === "working" || value === "idle" ? value : undefined
}

function withActiveRequestRun(timeline: RequestTimelineSnapshot | undefined, activeRequestRunId: string | undefined): RequestTimelineSnapshot {
  return {
    schemaVersion: 1,
    runs: timeline?.runs ?? [],
    pendingInputs: timeline?.pendingInputs ?? [],
    hasOlder: timeline?.hasOlder ?? false,
    ...(activeRequestRunId ? { activeRequestRunId } : {}),
  }
}

function requestFields(payload: EventEnvelope["payload"]) {
  const nested = object(object(payload.event)?.message)
  const fields: {
    requestRunId?: string
    phase?: AssistantTextPhase
    delivery?: UserInputDelivery
  } = {}
  const requestRunId = text(payload.requestRunId) ?? text(nested?.requestRunId)
  const phase = asPhase(payload.phase) ?? asPhase(nested?.phase)
  const delivery = asDelivery(payload.delivery) ?? asDelivery(nested?.delivery)
  if (requestRunId) fields.requestRunId = requestRunId
  if (phase) fields.phase = phase
  if (delivery) fields.delivery = delivery
  return fields
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
    ...(snapshot.timeline ? { timeline: snapshot.timeline } : previous?.timeline ? { timeline: previous.timeline } : {}),
    ...(snapshot.summary.execution ? { execution: snapshot.summary.execution } : previous?.execution ? { execution: previous.execution } : {}),
  }
  for (const event of bufferedEvents) restored = reduceConversation(restored, event)
  return restored
}

export function reduceConversation(state: ConversationState, event: EventEnvelope): ConversationState {
  if (!state.snapshotInstalled) {
    const bufferedEvents = event.seq <= state.lastSeq ? state.bufferedEvents : bufferEvent(state.bufferedEvents, event)
    return bufferedEvents === state.bufferedEvents ? state : { ...state, bufferedEvents }
  }
  if (state.requiresSnapshot) {
    const bufferedEvents = event.seq <= state.lastSeq ? state.bufferedEvents : bufferEvent(state.bufferedEvents, event)
    let recovered: ConversationState = { ...state, requiresSnapshot: false, bufferedEvents: [] }
    for (let index = 0; index < bufferedEvents.length; index++) {
      const buffered = bufferedEvents[index]!
      if (buffered.seq <= recovered.lastSeq) continue
      if (buffered.seq !== recovered.lastSeq + 1) {
        return { ...recovered, requiresSnapshot: true, bufferedEvents: bufferedEvents.slice(index) }
      }
      recovered = reduceConversation(recovered, buffered)
    }
    return recovered
  }
  if (event.seq <= state.lastSeq) return state
  if (event.seq !== state.lastSeq + 1) return { ...state, requiresSnapshot: true, recoveryVersion: state.recoveryVersion + 1, bufferedEvents: bufferEvent(state.bufferedEvents, event) }
  const payload = event.payload
  const nestedMessage = piMessage(payload)
  const id = text(payload.ephemeralMessageId) ?? text(payload.messageId) ?? (nestedMessage?.id || `event-${event.seq}`)
  const fields = requestFields(payload)
  let entries = state.entries

  switch (event.type) {
    case "message.start": {
      if (nestedMessage?.hidden) break
      const role = nestedMessage?.role ?? (payload.role === "user" ? "user" : "assistant")
      const startedText = nestedMessage?.text ?? text(payload.text) ?? ""
      const optimistic = nestedMessage?.role === "user"
        ? entries.findIndex((entry) => entry.kind === "message" && entry.role === "user" && entry.id.startsWith("optimistic-") && entry.text === startedText)
        : -1
      entries = optimistic < 0
        ? [...entries, { id, kind: "message", role, text: startedText, streaming: true, at: event.at, ...fields }]
        : entries.map((entry, position) => position === optimistic ? { id, kind: "message", role, text: startedText, streaming: true, at: event.at, ...fields } : entry)
      break
    }
    case "message.delta": {
      if (nestedMessage?.hidden) break
      const delta = nestedMessage?.text ?? text(payload.delta) ?? ""
      const index = entries.findIndex((entry) => entry.id === id && entry.kind === "message")
      entries = index < 0
        ? [...entries, { id, kind: "message", role: "assistant", text: delta, streaming: true, ...fields }]
        : entries.map((entry, position) => position === index && entry.kind === "message" ? { ...entry, text: nestedMessage ? delta : entry.text + delta, ...fields } : entry)
      break
    }
    case "message.commit": {
      if (nestedMessage?.hidden) break
      const committed = nestedMessage?.text ?? text(payload.text)
      const index = entries.findIndex((entry) => entry.id === id && entry.kind === "message")
      entries = index < 0
        ? [...entries, { id, kind: "message", role: nestedMessage?.role ?? "assistant", text: committed ?? "", streaming: false, at: event.at, ...fields }]
        : entries.map((entry, position) => position === index && entry.kind === "message" ? { ...entry, text: committed ?? entry.text, streaming: false, ...fields } : entry)
      break
    }
    case "tool.start":
      entries = [...entries, { id, kind: "tool", name: text(payload.name) ?? "도구", summary: text(payload.summary) ?? "실행 중", status: "running", ...(fields.requestRunId ? { requestRunId: fields.requestRunId } : {}) }]
      break
    case "tool.update":
    case "tool.end":
      entries = entries.map((entry) => entry.id === id && entry.kind === "tool" ? {
        ...entry,
        summary: text(payload.summary) ?? entry.summary,
        ...(text(payload.output) ?? entry.output ? { output: (text(payload.output) ?? entry.output)! } : {}),
        ...(text(payload.artifactId) ?? entry.artifactId ? { artifactId: (text(payload.artifactId) ?? entry.artifactId)! } : {}),
        ...(fields.requestRunId ? { requestRunId: fields.requestRunId } : {}),
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
    case "agent.state": {
      const execution = asExecution(payload.execution)
      return { ...state, lastSeq: event.seq, ...(execution ? { execution } : {}) }
    }
    case "session.changed": {
      if (text(payload.change) !== "requestRun") return { ...state, lastSeq: event.seq }
      return { ...state, lastSeq: event.seq, timeline: withActiveRequestRun(state.timeline, text(payload.activeRequestRunId)) }
    }
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
