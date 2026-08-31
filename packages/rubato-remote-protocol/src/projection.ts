import {
  FINAL_RESPONSE_PREVIEW_MAX_CHARS,
  PENDING_INPUT_PREVIEW_MAX_CHARS,
  REMOTE_PROTOCOL_CURRENT_VERSION,
  REMOTE_PROTOCOL_MIN_VERSION,
} from "./constants.js"
import { SUPPORTED_PROTOCOL_RANGE, supportsProtocolVersion } from "./compatibility.js"
import type { MessagePageResponse, SnapshotResponse } from "./http.js"
import type { ConversationEntry, SessionSnapshot, SessionSnapshotState } from "./surface.js"
import type { LiveSessionSummary } from "./types.js"

export function parseRequestedProtocolVersion(value: string | undefined | null): number | "protocol_mismatch" {
  if (value === undefined || value === null || value === "") return REMOTE_PROTOCOL_MIN_VERSION
  if (!/^[1-9]\d*$/.test(value)) return "protocol_mismatch"
  const version = Number(value)
  return supportsProtocolVersion(SUPPORTED_PROTOCOL_RANGE, version) ? version : "protocol_mismatch"
}

export function projectLiveSessionSummary(summary: LiveSessionSummary, protocolVersion: number): LiveSessionSummary {
  if (protocolVersion >= REMOTE_PROTOCOL_CURRENT_VERSION) return summary
  const { presentation: _presentation, ...rest } = summary
  return rest
}

export function projectConversationEntry(entry: ConversationEntry, protocolVersion: number): ConversationEntry | undefined {
  if (entry.kind === "thinking") return undefined
  if (protocolVersion >= REMOTE_PROTOCOL_CURRENT_VERSION) return entry
  if (entry.kind === "message") {
    return {
      id: entry.id,
      kind: "message",
      role: entry.role,
      text: entry.text,
      ...(entry.streaming === undefined ? {} : { streaming: entry.streaming }),
      ...(entry.at === undefined ? {} : { at: entry.at }),
    }
  }
  if (entry.kind === "tool") {
    return {
      id: entry.id,
      kind: "tool",
      name: entry.name,
      summary: entry.summary,
      status: entry.status,
      ...(entry.output === undefined ? {} : { output: entry.output }),
      ...(entry.artifactId === undefined ? {} : { artifactId: entry.artifactId }),
    }
  }
  if (entry.kind === "image") {
    return { id: entry.id, kind: "image", alt: entry.alt, url: entry.url }
  }
  return { id: entry.id, kind: "notice", text: entry.text }
}

export function projectConversationEntries(
  entries: readonly ConversationEntry[],
  protocolVersion: number,
): readonly ConversationEntry[] {
  return entries.flatMap((entry) => {
    const projected = projectConversationEntry(entry, protocolVersion)
    return projected === undefined ? [] : [projected]
  })
}

export function projectSessionSnapshotState(
  state: SessionSnapshotState,
  protocolVersion: number,
): SessionSnapshotState {
  const entries = projectConversationEntries(state.entries, protocolVersion)
  if (protocolVersion >= REMOTE_PROTOCOL_CURRENT_VERSION) {
    return state.entries === entries ? state : { ...state, entries }
  }
  const { timeline: _timeline, ...rest } = state
  return { ...rest, entries }
}

export function projectSessionSnapshot(snapshot: SessionSnapshot, protocolVersion: number): SessionSnapshot {
  return {
    ...snapshot,
    summary: projectLiveSessionSummary(snapshot.summary, protocolVersion),
    state: projectSessionSnapshotState(snapshot.state, protocolVersion),
  }
}

export function projectSnapshotResponse(response: SnapshotResponse, protocolVersion: number): SnapshotResponse {
  const entries = projectConversationEntries(response.entries, protocolVersion)
  if (protocolVersion >= REMOTE_PROTOCOL_CURRENT_VERSION) {
    return {
      ...response,
      summary: projectLiveSessionSummary(response.summary, protocolVersion),
      entries,
    }
  }
  const { timeline: _timeline, ...rest } = response
  return {
    ...rest,
    summary: projectLiveSessionSummary(response.summary, protocolVersion),
    entries,
  }
}

export function projectMessagePage(response: MessagePageResponse, protocolVersion: number): MessagePageResponse {
  const entries = projectConversationEntries(response.entries, protocolVersion)
  if (protocolVersion >= REMOTE_PROTOCOL_CURRENT_VERSION) return { ...response, entries }
  const { requestRuns: _requestRuns, ...rest } = response
  return { ...rest, entries }
}

export function previewFinalResponse(text: string): string | undefined {
  const preview = normalizePreview(text, FINAL_RESPONSE_PREVIEW_MAX_CHARS)
  return preview.length === 0 ? undefined : preview
}

export function previewPendingInput(text: string): string {
  return [...collapseWhitespace(text)].slice(0, PENDING_INPUT_PREVIEW_MAX_CHARS).join("")
}

function normalizePreview(text: string, maxChars: number): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, " ").replace(/```/g, " "))
  const unlinked = withoutFences
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
  return [...collapseWhitespace(unlinked)].slice(0, maxChars).join("")
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
