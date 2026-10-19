import {
  createChildProgress,
  TEAM_MESSAGE_CUSTOM_TYPE,
  type ChildAwaitedWake,
  type ChildTurnFacts,
  type ManagedChildEvent,
  type TaskRecord,
} from "@rubato/task"
import { readEnvelopeHeaders } from "@rubato/team-core/team-mailbox"

import { liveProgressSnapshot, type TaskLiveProgressSnapshot } from "./task-rpc-codec"

/**
 * What a resident child does between the runs the manager tracks. A team member wakes on its own
 * inbox (member-extension self-poller) and on its own background work; those turns never touch
 * its record, which keeps saying `completed` with the first run's answer. Hosts read this instead.
 */
export type MemberTurn = {
  readonly state: "working" | "resting"
  /** The last turn's final assistant text, newer than the record's when both exist. */
  readonly final_response?: string
  readonly ended_at?: string
  /** Work of its own that will wake it (a bounded background command, an unreported monitor). */
  readonly awaiting?: readonly ChildAwaitedWake[]
  /** The latest team message it received: who sent it and the summary they gave, if any. */
  readonly assignment?: { readonly from: string; readonly summary?: string }
}

export type MemberTurnWatch = {
  readonly turn: () => MemberTurn | undefined
  /** This watch's own live progress, only while a turn the manager does not track runs. */
  readonly progress: () => TaskLiveProgressSnapshot | undefined
  readonly dispose: () => void
}

export type MemberTurnWatchDeps = {
  readonly record: TaskRecord
  readonly subscribe: (listener: (event: ManagedChildEvent) => void) => () => void
  readonly readTurnFacts?: () => Promise<ChildTurnFacts>
  readonly changed: () => void
  readonly now?: () => number
}

const FINAL_RESPONSE_MAX = 32_000

export function watchMemberTurns(deps: MemberTurnWatchDeps): MemberTurnWatch {
  const now = deps.now ?? Date.now
  let disposed = false
  let turn: MemberTurn | undefined
  let turnText: string | undefined
  let progress: ReturnType<typeof createChildProgress> | undefined
  // A read answers for the moment it was asked; a turn that started since makes it stale.
  let generation = 0

  const set = (next: MemberTurn) => {
    turn = next
    deps.changed()
  }

  const refresh = (seed: boolean) => {
    const read = deps.readTurnFacts
    if (read === undefined) return
    const asked = generation
    void read()
      .then((facts) => {
        if (disposed || asked !== generation) return
        if (seed && facts.streaming === true) {
          startTurn()
          return
        }
        const final = turn?.final_response ?? (seed ? bounded(facts.lastAssistantText) : undefined)
        set({
          ...(turn ?? {}),
          state: "resting",
          ...(final === undefined ? {} : { final_response: final }),
          ...(facts.awaiting === undefined ? {} : { awaiting: facts.awaiting }),
        })
      })
      .catch(() => undefined)
  }

  const startTurn = () => {
    generation += 1
    turnText = undefined
    progress = createChildProgress(
      deps.record.task_id,
      {
        name: deps.record.name,
        taskSummary: deps.record.task_summary,
        description: deps.record.description,
        preset: deps.record.preset,
        resolvedModel: deps.record.resolved_model,
        model: deps.record.model,
      },
      now(),
      now,
    )
    const { awaiting: _awaiting, ...rest } = turn ?? { state: "working" as const }
    set({ ...rest, state: "working" })
  }

  const unsubscribe = deps.subscribe((event) => {
    if (disposed) return
    if (event.type === "agent_start") {
      startTurn()
      return
    }
    if (event.type === "message_end") {
      const assignment = assignmentOf(event.message)
      if (assignment !== undefined) {
        set({ ...(turn ?? { state: "working" }), assignment })
        return
      }
      const text = assistantText(event.message)
      if (text !== undefined) turnText = text
    }
    if (progress?.accept(event) === true && turn?.state === "working") deps.changed()
    if (event.type === "agent_end" && (event as { willRetry?: unknown }).willRetry !== true) {
      generation += 1
      progress = undefined
      const final = bounded(turnText) ?? turn?.final_response
      const { awaiting: _awaiting, ...rest } = turn ?? { state: "resting" as const }
      set({
        ...rest,
        state: "resting",
        ...(final === undefined ? {} : { final_response: final }),
        ended_at: new Date(now()).toISOString(),
      })
      refresh(false)
    }
  })
  refresh(true)

  return {
    turn: () => turn,
    progress: () => (turn?.state === "working" && progress !== undefined ? liveProgressSnapshot(progress.details()) : undefined),
    dispose: () => {
      disposed = true
      unsubscribe()
    },
  }
}

function bounded(text: string | undefined): string | undefined {
  const value = text?.trim()
  if (!value) return undefined
  return value.length > FINAL_RESPONSE_MAX ? value.slice(0, FINAL_RESPONSE_MAX) : value
}

function assistantText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const { role, content, stopReason } = message as { role?: unknown; content?: unknown; stopReason?: unknown }
  if (role !== "assistant" || stopReason === "error" || stopReason === "aborted" || !Array.isArray(content)) return undefined
  const text = content
    .flatMap((part: unknown) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("")
  return text.trim().length > 0 ? text : undefined
}

function assignmentOf(message: unknown): MemberTurn["assignment"] {
  if (typeof message !== "object" || message === null) return undefined
  const { role, customType, content } = message as { role?: unknown; customType?: unknown; content?: unknown }
  if (role !== "custom" || customType !== TEAM_MESSAGE_CUSTOM_TYPE) return undefined
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: unknown) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("")
      : ""
  // A batch carries several envelopes; the last one is what the member read last.
  return readEnvelopeHeaders(text).at(-1)
}
