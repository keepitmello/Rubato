import { createHash } from "node:crypto"

import { buildCompletionDetails, buildCompletionMessage } from "../completion/notification"
import type { CompletionDetails, ParentNotifierMessage } from "../completion/types"
import type { TaskRecord } from "../state"

/**
 * A resident member's turn end is not assignment completion. Wake only after every roster member
 * finishes, all assigned board work closes, and no peer work remains queued. An empty board proves
 * nothing; a missing result is reported as stalled rather than successful.
 *
 * Publish a stable batch id to the durable lead mailbox before advancing aggregate_woken_epoch.
 * The mailbox owns reservation, persistence acknowledgment and restart dedupe. An in-memory steer
 * enqueue is not delivery, and neither result bodies nor transcripts belong in the wake.
 */

export type TeamBatchMember = {
  readonly memberName: string
  /** The member's task record, or undefined when the member has no record in this store. */
  readonly record: TaskRecord | undefined
}

export type TeamBatchDecision =
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "wake"; readonly members: readonly TeamBatchMember[] }
  // `members` is always the WHOLE batch: the bookkeeping must be closed for every member, otherwise
  // the ones that did leave a result stay owed and the stalled notice repeats forever.
  | { readonly kind: "stalled"; readonly members: readonly TeamBatchMember[]; readonly withoutResult: readonly string[] }

export type DecideTeamBatchWakeInput = {
  readonly members: readonly TeamBatchMember[]
  /** Non-deleted board items for the run. */
  readonly boardItems: number
  /** Board items for the run that are not `completed`. */
  readonly openBoardItems: number
  /** Members with queued inbound work (unread mail or a pending injected message). */
  readonly pendingInbound: ReadonlySet<string>
}

export function decideTeamBatchWake(input: DecideTeamBatchWakeInput): TeamBatchDecision {
  if (input.members.length === 0) return { kind: "wait", reason: "no-members" }
  for (const member of input.members) {
    if (member.record === undefined) return { kind: "wait", reason: `member-unmapped:${member.memberName}` }
    if (member.record.status !== "completed") {
      return { kind: "wait", reason: `member-unfinished:${member.memberName}:${member.record.status}` }
    }
  }
  if (input.boardItems === 0) return { kind: "wait", reason: "no-assigned-work" }
  if (input.openBoardItems > 0) return { kind: "wait", reason: `open-board-items:${input.openBoardItems}` }
  for (const member of input.members) {
    if (input.pendingInbound.has(member.memberName)) {
      return { kind: "wait", reason: `member-has-queued-work:${member.memberName}` }
    }
  }
  const owed = input.members.some((member) => aggregateWokenEpoch(member.record) < runEpoch(member.record))
  if (!owed) return { kind: "wait", reason: "already-woken" }
  const withoutResult = input.members.filter((member) => !hasResultBody(member.record))
  if (withoutResult.length > 0) {
    return { kind: "stalled", members: input.members, withoutResult: withoutResult.map((m) => m.memberName) }
  }
  return { kind: "wake", members: input.members }
}

export type TeamBatchTeam = {
  readonly teamRunId: string
  readonly teamName: string
  readonly members: readonly { readonly name: string; readonly taskId: string | undefined }[]
}

export type TeamBatchWakePorts = {
  /** Active teams whose lead session is `currentSessionId()`, with their member task map. */
  readonly activeTeams: () => Promise<readonly TeamBatchTeam[]>
  readonly currentSessionId: () => string | undefined
  readonly loadRecord: (taskId: string) => TaskRecord | null
  /** Non-deleted board items for the run, and how many of those are not `completed`. */
  readonly boardState: (teamRunId: string) => Promise<{ readonly items: number; readonly open: number }>
  readonly pendingInbound: (teamRunId: string, memberName: string) => Promise<number>
  /** Resolve only after the stable message id is durable in the recipient inbox (or already consumed). */
  readonly deliver: (message: ParentNotifierMessage, team: TeamBatchTeam, messageId: string) => void | Promise<void>
  /** Stamp only after durable mailbox acceptance, not after an in-memory steer enqueue. */
  readonly markWoken: (taskId: string, epoch: number) => void
  /** Resolved task state dir; result files live under `<stateDir>/completion-results`. */
  readonly stateDir: string
  readonly onError?: (error: unknown) => void
}

export type TeamBatchWakeResult =
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "delivered"; readonly teamRunId: string; readonly members: readonly string[] }
  | { readonly kind: "stalled"; readonly teamRunId: string; readonly members: readonly string[] }
  | { readonly kind: "failed"; readonly teamRunId: string; readonly error: unknown }

export type TeamBatchWake = {
  /** Evaluate every lead-owned active team once. Returns what each run decided. */
  evaluate: () => Promise<readonly TeamBatchWakeResult[]>
  /** Coalesce a burst of store mutations into one evaluation. */
  schedule: () => void
}

export const BATCH_WAKE_DEBOUNCE_MS = 250

export function createTeamBatchWake(ports: TeamBatchWakePorts): TeamBatchWake {
  let scheduled = false
  // evaluate() is serialized. Two producers overlap in production (session_start's chain and the
  // debounced store-mutation schedule, both awaiting the async board/mailbox reads); without a lock
  // both read the pre-mark state and both deliver. Chaining instead of dropping means the second call
  // still sees whatever the first one marked, and a batch that only became true during the first pass
  // is still delivered exactly once.
  let tail: Promise<unknown> = Promise.resolve()

  async function evaluateTeam(team: TeamBatchTeam): Promise<TeamBatchWakeResult> {
    const board = await ports.boardState(team.teamRunId)
    const pending = new Set<string>()
    for (const member of team.members) {
      if ((await ports.pendingInbound(team.teamRunId, member.name)) > 0) pending.add(member.name)
    }
    // Read records after the asynchronous mailbox checks: a queued message may already have revived
    // a member while those checks ran.
    const members: TeamBatchMember[] = team.members.map((member) => ({
      memberName: member.name,
      record: member.taskId === undefined ? undefined : (ports.loadRecord(member.taskId) ?? undefined),
    }))
    const decision = decideTeamBatchWake({
      members,
      boardItems: board.items,
      openBoardItems: board.open,
      pendingInbound: pending,
    })
    if (decision.kind === "wait") return { kind: "wait", reason: decision.reason }

    const names = decision.members.map((member) => member.memberName)
    const message = decision.kind === "stalled"
      ? buildStalledMessage(team, decision.withoutResult)
      : buildTeamBatchMessage(team, decision.members, decision.members.map((member) => buildMemberDetails(ports.stateDir, member)))
    try {
      await ports.deliver(message, team, teamBatchMessageId(team, decision.members))
    } catch (error) {
      ports.onError?.(error)
      return { kind: "failed", teamRunId: team.teamRunId, error }
    }
    // The inbox now durably owns delivery, including a stalled notice for EVERY member. These
    // markers avoid republishing on ordinary ticks; the stable message id covers a crash mid-mark.
    for (const member of decision.members) {
      const record = member.record
      if (record === undefined) continue
      ports.markWoken(record.task_id, runEpoch(record))
    }
    return decision.kind === "stalled"
      ? { kind: "stalled", teamRunId: team.teamRunId, members: names }
      : { kind: "delivered", teamRunId: team.teamRunId, members: names }
  }

  async function evaluate(): Promise<readonly TeamBatchWakeResult[]> {
    const sessionId = ports.currentSessionId()
    if (sessionId === undefined || sessionId.length === 0) return []
    let teams: readonly TeamBatchTeam[]
    try {
      teams = await ports.activeTeams()
    } catch (error) {
      ports.onError?.(error)
      return []
    }
    const results: TeamBatchWakeResult[] = []
    for (const team of teams) {
      try {
        results.push(await evaluateTeam(team))
      } catch (error) {
        ports.onError?.(error)
        results.push({ kind: "failed", teamRunId: team.teamRunId, error })
      }
    }
    return results
  }

  function serializedEvaluate(): Promise<readonly TeamBatchWakeResult[]> {
    const next = tail.then(evaluate)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return {
    evaluate: serializedEvaluate,
    schedule(): void {
      if (scheduled) return
      scheduled = true
      const timer = setTimeout(() => {
        scheduled = false
        void serializedEvaluate()
      }, BATCH_WAKE_DEBOUNCE_MS)
      timer.unref?.()
    },
  }
}

function teamBatchMessageId(team: TeamBatchTeam, members: readonly TeamBatchMember[]): string {
  const runs = members.map((member) => [member.memberName, member.record?.task_id, runEpoch(member.record)])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  const hash = createHash("sha256").update(JSON.stringify([team.teamRunId, runs])).digest("hex")
  // UUIDv8: application-defined, deterministic identity for this roster and its run epochs.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function buildMemberDetails(stateDir: string, member: TeamBatchMember): CompletionDetails {
  const record = member.record
  if (record === undefined) throw new TypeError(`team batch member '${member.memberName}' has no record`)
  // Label the member, not the task name (`team:<run>:<member>`): the lead reads a member name.
  return { ...buildCompletionDetails(record, { stateDir }), name: member.memberName }
}

function buildTeamBatchMessage(
  team: TeamBatchTeam,
  members: readonly TeamBatchMember[],
  details: readonly CompletionDetails[],
): ParentNotifierMessage {
  const base = buildCompletionMessage(details)
  const header = `Team batch complete · ${team.teamName} · ${members.length} member(s) finished`
  return {
    ...base,
    content: [header, base.content].join("\n"),
    triggerTurn: true,
  }
}

function buildStalledMessage(team: TeamBatchTeam, members: readonly string[]): ParentNotifierMessage {
  return {
    customType: "rubato.task.completion",
    content: [
      `Team batch stalled · ${team.teamName} · no result left by ${members.join(", ")}`,
      "Every assigned board item is closed and these members are parked with no result body, so the batch cannot be reported as complete.",
    ].join("\n"),
    display: false,
    details: [],
    triggerTurn: true,
  }
}

function hasResultBody(record: TaskRecord | undefined): boolean {
  if (record === undefined) return false
  return (record.final_response ?? record.error_message ?? "").length > 0
}

function runEpoch(record: TaskRecord | undefined): number {
  return record?.notification.run_epoch ?? -1
}

function aggregateWokenEpoch(record: TaskRecord | undefined): number {
  return record?.notification.aggregate_woken_epoch ?? -1
}
