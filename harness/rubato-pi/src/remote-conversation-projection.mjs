const FINAL_PREVIEW_MAX_CHARS = 240
const PENDING_PREVIEW_MAX_CHARS = 500
const PAGE_LIMIT_MAX = 100
const PAGE_RAW_CAP = 250

export function messageText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n")
}

export function conversationEntries(entries, protocol, options = {}) {
  const limit = options.limit ?? 100
  const mapped = []
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.id !== "string") continue
    if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
      mapped.push({
        id: entry.id,
        kind: "message",
        role: entry.message.role,
        text: messageText(entry.message.content),
        ...(entry.timestamp ? { at: entry.timestamp } : {}),
      })
      continue
    }
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      mapped.push({
        id: entry.id,
        kind: "tool",
        name: String(entry.message.toolName ?? "tool"),
        summary: messageText(entry.message.content),
        status: entry.message.isError ? "failed" : "done",
      })
      continue
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      mapped.push({ id: entry.id, kind: "notice", text: String(entry.summary ?? "Session compacted") })
      continue
    }
    if (entry.type === "custom_message" && entry.display !== false) {
      mapped.push({ id: entry.id, kind: "notice", text: messageText(entry.content) })
    }
  }
  const sliced = mapped.slice(-limit)
  return sliced.map((entry) => protocol ? protocol.redactSecrets ? jsonSafe(protocol, entry) : entry : entry)
}

export function paginateConversation(entries, input = {}) {
  const limit = clampLimit(input.limit)
  const before = typeof input.before === "string" && input.before.length > 0 ? input.before : undefined
  if (before && !entries.some((entry) => entry.id === before)) {
    return { error: "invalid_action", message: "Unknown conversation cursor" }
  }
  const end = before ? entries.findIndex((entry) => entry.id === before) : entries.length
  if (end < 0) return { error: "invalid_action", message: "Unknown conversation cursor" }
  const rawStart = Math.max(0, end - PAGE_RAW_CAP)
  const window = entries.slice(rawStart, end)
  const page = window.slice(-limit)
  const nextBefore = page[0]?.id
  const hasOlder = rawStart > 0 || window.length > page.length
  return {
    entries: page,
    nextBefore: hasOlder ? nextBefore : undefined,
  }
}

export function lastCompletedRun(timeline) {
  if (!timeline || !Array.isArray(timeline.runs)) return undefined
  return [...timeline.runs].reverse().find((run) => run.status === "completed")
}

export function timelineChangePayloads(previous, next) {
  if (!next) return []
  const payloads = []
  const prevPending = JSON.stringify(previous?.pendingInputs ?? [])
  const nextPending = JSON.stringify(next.pendingInputs ?? [])
  if (prevPending !== nextPending) {
    payloads.push({ change: "pendingInputs", pendingInputs: next.pendingInputs })
  }
  const prevRuns = new Map((previous?.runs ?? []).map((run) => [run.id, runChangeKey(run)]))
  for (const run of next.runs ?? []) {
    if (prevRuns.get(run.id) !== runChangeKey(run)) {
      payloads.push({
        change: "requestRun",
        requestRun: run,
        ...(next.activeRequestRunId ? { activeRequestRunId: next.activeRequestRunId } : {}),
      })
    }
  }
  if (
    previous?.activeRequestRunId !== next.activeRequestRunId
    && !payloads.some((payload) => payload.change === "requestRun")
  ) {
    const run = (next.runs ?? []).find((item) => item.id === next.activeRequestRunId)
      ?? (previous?.runs ?? []).find((item) => item.id === previous.activeRequestRunId)
    if (run) {
      payloads.push({
        change: "requestRun",
        requestRun: run,
        ...(next.activeRequestRunId ? { activeRequestRunId: next.activeRequestRunId } : {}),
      })
    }
  }
  return payloads
}

export function sanitizePageEntries(entries, protocol) {
  return (entries ?? [])
    .filter((entry) => entry && typeof entry.id === "string" && entry.kind !== "thinking")
    .map((entry) => protocol ? jsonSafe(protocol, entry) : entry)
}

export function presentationFromTimeline(timeline, options = {}) {
  if (!timeline || !Array.isArray(timeline.runs)) return undefined
  const pending = Array.isArray(timeline.pendingInputs) ? timeline.pendingInputs : []
  const active = timeline.runs.find((run) => run.id === timeline.activeRequestRunId)
  const live = active && (active.status === "running" || active.status === "awaiting_input") ? active : undefined
  const completed = lastCompletedRun(timeline)
  const lastFinalText = options.lastFinalText
    ?? (completed?.finalMessageId ? options.finalByMessageId?.[completed.finalMessageId] : undefined)
  const lastFinal = lastFinalText === undefined ? undefined : previewFinalResponse(lastFinalText)
  const lastFinalAt = options.lastFinalAt ?? (lastFinal ? completed?.completedAt : undefined)
  return {
    schemaVersion: 1,
    ...(lastFinal ? { lastFinalResponsePreview: lastFinal } : {}),
    ...(lastFinal && lastFinalAt ? { lastFinalResponseAt: lastFinalAt } : {}),
    ...(live ? {
      activeRequest: {
        id: live.id,
        status: live.status,
        startedAt: live.startedAt,
        ...(live.lastProgressPreview ? { lastProgressPreview: live.lastProgressPreview } : {}),
        toolCount: live.toolCount,
        failedToolCount: live.failedToolCount,
      },
    } : {}),
    pendingFollowUpCount: pending.filter((item) => item.delivery === "followUp").length,
    pendingSteerCount: pending.filter((item) => item.delivery === "steer").length,
  }
}

export function previewFinalResponse(text) {
  const preview = normalizePreview(String(text ?? ""), FINAL_PREVIEW_MAX_CHARS)
  return preview.length === 0 ? undefined : preview
}

export function previewPendingInput(text) {
  return [...String(text ?? "").replace(/\s+/g, " ").trim()].slice(0, PENDING_PREVIEW_MAX_CHARS).join("")
}

function clampLimit(value) {
  if (!Number.isSafeInteger(value)) return 50
  return Math.min(PAGE_LIMIT_MAX, Math.max(1, value))
}

function normalizePreview(text, maxChars) {
  const withoutFences = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, " ").replace(/```/g, " "))
  const unlinked = withoutFences
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
  return [...unlinked.replace(/\s+/g, " ").trim()].slice(0, maxChars).join("")
}

function jsonSafe(protocol, value) {
  try {
    return JSON.parse(JSON.stringify(protocol.redactSecrets(value), (_key, member) =>
      typeof member === "bigint" ? member.toString() : member))
  } catch {
    return { normalizationError: true }
  }
}

function runChangeKey(run) {
  return JSON.stringify({
    id: run.id,
    status: run.status,
    completedAt: run.completedAt,
    finalMessageId: run.finalMessageId,
    progressMessageCount: run.progressMessageCount,
    toolCount: run.toolCount,
    failedToolCount: run.failedToolCount,
    steeringCount: run.steeringCount,
    failureMessage: run.failureMessage,
  })
}

export function sanitizeRemoteMessageEvent(event) {
  const message = event?.message && typeof event.message === "object" ? event.message : undefined
  const sanitized = {}
  if (typeof event?.type === "string") sanitized.type = event.type
  if (typeof event?.messageId === "string") sanitized.messageId = event.messageId
  if (typeof event?.assistantMessageId === "string") sanitized.assistantMessageId = event.assistantMessageId
  if (message) {
    const content = sanitizeMessageContent(message.content)
    sanitized.message = {
      ...(typeof message.id === "string" ? { id: message.id } : {}),
      ...(typeof message.role === "string" ? { role: message.role } : {}),
      ...(content === undefined ? {} : { content }),
      ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    }
  }
  return sanitized
}

function sanitizeMessageContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => ({ type: "text", text: part.text }))
}
