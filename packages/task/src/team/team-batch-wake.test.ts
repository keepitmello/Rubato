import { describe, expect, test } from "bun:test"

import { writeCompletionResultFile } from "../completion/notification"
import type { ParentNotifierMessage } from "../completion/types"
import type { TaskRecord } from "../state"
import { createTeamBatchWake, decideTeamBatchWake, type TeamBatchTeam } from "./team-batch-wake"

const TEAM_RUN = "2f9e2f40-87f7-4e92-a9ed-3516de761d81"
const LEAD_SESSION = "01a0c81c-9dc1-7701-bd59-fc7a9612db8b"
const STATE_DIR = "/tmp/rubato-team-batch-fixture"

function memberRecord(name: string, taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: taskId,
    name: `team:${TEAM_RUN}:${name}`,
    parent_session_id: LEAD_SESSION,
    root_session_id: LEAD_SESSION,
    depth: 1,
    execution_mode: "process",
    model: "xai/grok-4.7",
    status: "completed",
    residency_state: "resident",
    created_at: "2026-09-22T08:17:28.761Z",
    updated_at: "2026-09-22T08:21:02.117Z",
    final_response: `${name} report`,
    notify_on_terminal: true,
    notification: { run_epoch: 0, notified_epoch: 0 },
    ...overrides,
  }
}

type Harness = ReturnType<typeof harness>

function harness(options: {
  readonly members?: readonly { name: string; taskId: string | undefined }[]
  readonly records?: readonly TaskRecord[]
  readonly boardItems?: number
  readonly openBoardItems?: number
  readonly unread?: Readonly<Record<string, number>>
  readonly pendingInjected?: Readonly<Record<string, number>>
  readonly failDelivery?: boolean
  readonly sessionId?: string | undefined
  /** Resolves the board read manually, so two evaluate() calls can overlap deterministically. */
  readonly boardGate?: { readonly promise: Promise<void> }
} = {}) {
  const records = new Map((options.records ?? []).map((record) => [record.task_id, record]))
  const delivered: ParentNotifierMessage[] = []
  const members = options.members ?? [
    { name: "owner", taskId: "st_owner" },
    { name: "verifier", taskId: "st_verifier" },
  ]
  const teams: TeamBatchTeam[] = [{ teamRunId: TEAM_RUN, teamName: "agent-result-hygiene", members }]
  const wake = createTeamBatchWake({
    activeTeams: async () => teams,
    currentSessionId: () => ("sessionId" in options ? options.sessionId : LEAD_SESSION),
    loadRecord: (taskId) => records.get(taskId) ?? null,
    boardState: async () => {
      if (options.boardGate !== undefined) await options.boardGate.promise
      return { items: options.boardItems ?? 2, open: options.openBoardItems ?? 0 }
    },
    pendingInbound: async (_runId, memberName) =>
      (options.unread?.[memberName] ?? 0) + (options.pendingInjected?.[memberName] ?? 0),
    deliver: (message) => {
      if (options.failDelivery === true) throw new Error("parent gone")
      delivered.push(message)
    },
    markWoken: (taskId, epoch) => {
      const current = records.get(taskId)
      if (current === undefined) return
      records.set(taskId, {
        ...current,
        notification: { ...current.notification, aggregate_woken_epoch: epoch },
      })
    },
    stateDir: STATE_DIR,
  })
  return { wake, delivered, records, teams }
}

describe("team batch wake decision", () => {
  test("#given no board items #when every member is parked #then nothing is reported as finished", () => {
    // given: the prompted work is not observable on any board, so 'all parked' proves nothing
    const members = [
      { memberName: "owner", record: memberRecord("owner", "st_owner") },
      { memberName: "verifier", record: memberRecord("verifier", "st_verifier") },
    ]

    // when
    const decision = decideTeamBatchWake({ members, boardItems: 0, openBoardItems: 0, pendingInbound: new Set() })

    // then
    expect(decision).toEqual({ kind: "wait", reason: "no-assigned-work" })
  })

  test("#given an assigned item is still open #when every member is parked #then it waits", () => {
    // given: a member parked while its assigned item is still open is a member waiting, not a batch end
    const members = [
      { memberName: "owner", record: memberRecord("owner", "st_owner") },
      { memberName: "verifier", record: memberRecord("verifier", "st_verifier") },
    ]

    // when
    const decision = decideTeamBatchWake({ members, boardItems: 2, openBoardItems: 1, pendingInbound: new Set() })

    // then
    expect(decision).toEqual({ kind: "wait", reason: "open-board-items:1" })
  })

  test("#given a member is about to be revived by queued mail #when everything else is closed #then it waits", () => {
    // given
    const members = [
      { memberName: "owner", record: memberRecord("owner", "st_owner") },
      { memberName: "verifier", record: memberRecord("verifier", "st_verifier") },
    ]

    // when
    const decision = decideTeamBatchWake({
      members,
      boardItems: 2,
      openBoardItems: 0,
      pendingInbound: new Set(["verifier"]),
    })

    // then
    expect(decision).toEqual({ kind: "wait", reason: "member-has-queued-work:verifier" })
  })

  test("#given a member is still running #when the other is parked #then it waits", () => {
    // given
    const members = [
      { memberName: "owner", record: memberRecord("owner", "st_owner", { status: "running" }) },
      { memberName: "verifier", record: memberRecord("verifier", "st_verifier") },
    ]

    // when
    const decision = decideTeamBatchWake({ members, boardItems: 2, openBoardItems: 0, pendingInbound: new Set() })

    // then
    expect(decision).toEqual({ kind: "wait", reason: "member-unfinished:owner:running" })
  })

  test("#given a member failed #when the board is closed #then it is never a success batch", () => {
    // given
    const members = [
      { memberName: "owner", record: memberRecord("owner", "st_owner") },
      { memberName: "verifier", record: memberRecord("verifier", "st_verifier", { status: "error" }) },
    ]

    // when
    const decision = decideTeamBatchWake({ members, boardItems: 2, openBoardItems: 0, pendingInbound: new Set() })

    // then
    expect(decision).toEqual({ kind: "wait", reason: "member-unfinished:verifier:error" })
  })

  test("#given every assigned item is closed and every member parked #then the batch is finished", () => {
    // given
    const members = [
      { memberName: "owner", record: memberRecord("owner", "st_owner") },
      { memberName: "verifier", record: memberRecord("verifier", "st_verifier") },
    ]

    // when
    const decision = decideTeamBatchWake({ members, boardItems: 2, openBoardItems: 0, pendingInbound: new Set() })

    // then
    expect(decision.kind).toBe("wake")
  })

  test("#given a parked member left no result #when the batch is otherwise closed #then it is a stalled batch, not a success", () => {
    // given
    const members = [
      { memberName: "owner", record: memberRecord("owner", "st_owner") },
      { memberName: "verifier", record: memberRecord("verifier", "st_verifier", { final_response: "" }) },
    ]

    // when
    const decision = decideTeamBatchWake({ members, boardItems: 2, openBoardItems: 0, pendingInbound: new Set() })

    // then: the whole batch is carried so the bookkeeping closes for every member
    expect(decision).toEqual({ kind: "stalled", members, withoutResult: ["verifier"] })
  })
})

describe("team batch wake delivery", () => {
  test("#given both members parked and every item closed #when evaluated #then one wake carries both result paths", async () => {
    // given
    const owner = memberRecord("owner", "st_owner")
    const verifier = memberRecord("verifier", "st_verifier")
    writeCompletionResultFile(STATE_DIR, "st_owner", owner.notification.run_epoch, owner.final_response ?? "")
    writeCompletionResultFile(STATE_DIR, "st_verifier", verifier.notification.run_epoch, verifier.final_response ?? "")
    const h: Harness = harness({ records: [owner, verifier] })

    // when
    const results = await h.wake.evaluate()

    // then
    expect(results).toEqual([{ kind: "delivered", teamRunId: TEAM_RUN, members: ["owner", "verifier"] }])
    expect(h.delivered).toHaveLength(1)
    const content = h.delivered[0]?.content ?? ""
    expect(content).toContain("Team batch complete · agent-result-hygiene · 2 member(s) finished")
    expect(content).toContain("completed owner st_owner")
    expect(content).toContain("completed verifier st_verifier")
    expect(content).toContain(`result ${STATE_DIR}/completion-results/st_owner/0.txt`)
    expect(content).toContain(`result ${STATE_DIR}/completion-results/st_verifier/0.txt`)
    // never a body
    expect(content).not.toContain("owner report")
    expect(content).not.toContain("verifier report")
    expect(h.delivered[0]?.triggerTurn).toBe(true)
  })

  test("#given the batch already woke #when evaluated again #then no second wake", async () => {
    // given
    const h: Harness = harness({
      records: [
        memberRecord("owner", "st_owner"),
        memberRecord("verifier", "st_verifier"),
      ],
    })
    await h.wake.evaluate()

    // when
    const second = await h.wake.evaluate()

    // then
    expect(second).toEqual([{ kind: "wait", reason: "already-woken" }])
    expect(h.delivered).toHaveLength(1)
  })

  test("#given a restart after the batch woke #when evaluated on a fresh instance #then it does not repeat", async () => {
    // given: the marker rides the member records, so a new process sees it
    const owner = memberRecord("owner", "st_owner", {
      notification: { run_epoch: 0, notified_epoch: 0, aggregate_woken_epoch: 0 },
    })
    const verifier = memberRecord("verifier", "st_verifier", {
      notification: { run_epoch: 0, notified_epoch: 0, aggregate_woken_epoch: 0 },
    })
    const h: Harness = harness({ records: [owner, verifier] })

    // when
    const results = await h.wake.evaluate()

    // then
    expect(results).toEqual([{ kind: "wait", reason: "already-woken" }])
    expect(h.delivered).toHaveLength(0)
  })

  test("#given a member was revived with follow-up work #when it parks again #then the batch wakes once more", async () => {
    // given
    const h: Harness = harness({
      records: [
        memberRecord("owner", "st_owner", { notification: { run_epoch: 0, notified_epoch: 0, aggregate_woken_epoch: 0 } }),
        memberRecord("verifier", "st_verifier", { notification: { run_epoch: 0, notified_epoch: 0, aggregate_woken_epoch: 0 } }),
      ],
    })
    h.records.set("st_verifier", memberRecord("verifier", "st_verifier", {
      notification: { run_epoch: 1, notified_epoch: 1, aggregate_woken_epoch: 0 },
      final_response: "re-verification verdict",
    }))

    // when
    const results = await h.wake.evaluate()

    // then
    expect(results).toEqual([{ kind: "delivered", teamRunId: TEAM_RUN, members: ["owner", "verifier"] }])
    expect(h.delivered).toHaveLength(1)
    expect(h.records.get("st_verifier")?.notification.aggregate_woken_epoch).toBe(1)
  })

  test("#given a member parked without a result #when evaluated #then a stalled notice is delivered, not a success", async () => {
    // given
    const h: Harness = harness({
      records: [
        memberRecord("owner", "st_owner"),
        memberRecord("verifier", "st_verifier", { final_response: "" }),
      ],
    })

    // when
    const results = await h.wake.evaluate()

    // then
    // the whole batch is reported so the bookkeeping closes for every member
    expect(results).toEqual([{ kind: "stalled", teamRunId: TEAM_RUN, members: ["owner", "verifier"] }])
    const content = h.delivered[0]?.content ?? ""
    expect(content).toContain("Team batch stalled")
    expect(content).toContain("no result left by verifier")
    expect(content).not.toContain("Team batch complete")
  })

  test("#given a stalled notice was delivered #when evaluated again #then it does not repeat", async () => {
    // given: a member that did leave a result must be marked too, or it stays owed forever
    const h: Harness = harness({
      records: [
        memberRecord("owner", "st_owner"),
        memberRecord("verifier", "st_verifier", { final_response: "" }),
      ],
    })
    await h.wake.evaluate()

    // when
    const second = await h.wake.evaluate()

    // then
    expect(second).toEqual([{ kind: "wait", reason: "already-woken" }])
    expect(h.delivered).toHaveLength(1)
    expect(h.records.get("st_owner")?.notification.aggregate_woken_epoch).toBe(0)
    expect(h.records.get("st_verifier")?.notification.aggregate_woken_epoch).toBe(0)
  })

  test("#given two evaluate calls overlap #when both were held on the board read #then the batch wakes exactly once", async () => {
    // given: session_start's chain and the debounced store-mutation schedule both await async reads
    let release = () => {}
    const gate = { promise: new Promise<void>((resolve) => { release = resolve }) }
    const h: Harness = harness({
      records: [memberRecord("owner", "st_owner"), memberRecord("verifier", "st_verifier")],
      boardGate: gate,
    })

    // when: both calls are in flight before either has marked the batch
    const first = h.wake.evaluate()
    const second = h.wake.evaluate()
    await Promise.resolve()
    release()
    const results = await Promise.all([first, second])

    // then: the second call re-reads after the first mark instead of delivering a duplicate
    expect(h.delivered).toHaveLength(1)
    expect(results.flat().filter((result) => result.kind === "delivered")).toHaveLength(1)
    expect(results.flat().filter((result) => result.kind === "wait" && result.reason === "already-woken")).toHaveLength(1)
  })

  test("#given delivery fails #when evaluated #then the batch stays owed instead of being marked woken", async () => {
    // given
    const h: Harness = harness({
      records: [memberRecord("owner", "st_owner"), memberRecord("verifier", "st_verifier")],
      failDelivery: true,
    })

    // when
    const results = await h.wake.evaluate()

    // then
    expect(results[0]?.kind).toBe("failed")
    expect(h.records.get("st_owner")?.notification.aggregate_woken_epoch).toBeUndefined()
  })

  test("#given this session owns no team #when evaluated #then it does nothing", async () => {
    // given
    const h: Harness = harness({
      records: [memberRecord("owner", "st_owner"), memberRecord("verifier", "st_verifier")],
      sessionId: undefined,
    })

    // when
    const results = await h.wake.evaluate()

    // then
    expect(results).toEqual([])
    expect(h.delivered).toHaveLength(0)
  })
})
