import type { ConversationEntry, RequestTimelineSnapshot } from "@rubato/remote-protocol"

type MessageEntry = Extract<ConversationEntry, { kind: "message" }>

export type VisibleConversationItem =
  | { kind: "message"; entry: MessageEntry }
  | { kind: "collapsed-progress"; runId: string; entries: readonly MessageEntry[] }

interface RunGroup {
  readonly runId: string
  readonly messages: MessageEntry[]
}

export function visibleConversationItems(
  entries: readonly ConversationEntry[],
  options?: {
    working?: boolean
    activeRequestRunId?: string
    timeline?: RequestTimelineSnapshot
  },
): readonly VisibleConversationItem[] {
  const runs = groupRuns(entries)
  return runs.flatMap((run, index) => emitRun(run, runIsExpanded(run, index === runs.length - 1, options)))
}

function isMessage(entry: ConversationEntry): entry is MessageEntry {
  return entry.kind === "message"
}

function groupRuns(entries: readonly ConversationEntry[]): RunGroup[] {
  const runs: RunGroup[] = []
  let current: RunGroup | undefined
  for (const entry of entries) {
    if (!isMessage(entry)) continue
    const nextRunId = entry.requestRunId
      ?? (entry.role === "user" && entry.delivery !== "steer" ? `legacy:${entry.id}` : undefined)
    if (nextRunId !== undefined && current?.runId !== nextRunId) {
      current = { runId: nextRunId, messages: [] }
      runs.push(current)
    } else if (!current) {
      current = { runId: `legacy:${entry.id}`, messages: [] }
      runs.push(current)
    }
    current.messages.push(entry)
  }
  return runs
}

function runIsExpanded(
  run: RunGroup,
  isLast: boolean,
  options?: {
    working?: boolean
    activeRequestRunId?: string
    timeline?: RequestTimelineSnapshot
  },
): boolean {
  if (run.runId === options?.activeRequestRunId || run.runId === options?.timeline?.activeRequestRunId) return true
  if (run.messages.some((entry) => entry.role === "assistant" && entry.streaming === true)) return true
  return options?.working === true && isLast
}

function emitRun(run: RunGroup, expanded: boolean): readonly VisibleConversationItem[] {
  if (expanded) return run.messages.map((entry) => ({ kind: "message" as const, entry }))
  const assistants = run.messages.filter((entry) => entry.role === "assistant")
  if (assistants.length === 0) return run.messages.map((entry) => ({ kind: "message" as const, entry }))
  const progress = new Set(progressAssistants(assistants))
  const items: VisibleConversationItem[] = []
  let collapsed = false
  for (const entry of run.messages) {
    if (entry.role === "user" || !progress.has(entry)) {
      items.push({ kind: "message", entry })
      continue
    }
    if (collapsed) continue
    items.push({ kind: "collapsed-progress", runId: run.runId, entries: assistants.filter((item) => progress.has(item)) })
    collapsed = true
  }
  return items
}

function progressAssistants(assistants: readonly MessageEntry[]): readonly MessageEntry[] {
  if (assistants.some((entry) => entry.phase !== undefined)) {
    return assistants.filter((entry) => entry.phase !== "final")
  }
  let lastFinalIndex = -1
  for (let index = assistants.length - 1; index >= 0; index--) {
    if (assistants[index]!.streaming !== true) {
      lastFinalIndex = index
      break
    }
  }
  if (lastFinalIndex < 0) return assistants
  return assistants.filter((_, index) => index !== lastFinalIndex)
}
