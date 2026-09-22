import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import type { TaskRecord } from "../state"
import type { PersistedTaskEvent } from "../store"
import { createCompletionNotifier } from "./notifier"
import type { ParentNotifier, ParentNotifierMessage } from "./types"

const TEAM_RUN = "2f9e2f40-87f7-4e92-a9ed-3516de761d81"

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "st_member",
    name: `team:${TEAM_RUN}:verifier`,
    parent_session_id: "lead-session",
    root_session_id: "lead-session",
    depth: 1,
    execution_mode: "process",
    model: "xai/grok-4.7",
    status: "completed",
    residency_state: "resident",
    created_at: "2026-09-22T08:17:28.761Z",
    updated_at: "2026-09-22T08:21:02.117Z",
    final_response: "verdict: baseline hash matches",
    notify_on_terminal: true,
    notification: { run_epoch: 0, notified_epoch: -1 },
    ...overrides,
  }
}

function fakeStore(seed: readonly TaskRecord[]) {
  const records = new Map(seed.map((entry) => [entry.task_id, entry]))
  return {
    records,
    store: {
      load: (taskId: string): TaskRecord | null => records.get(taskId) ?? null,
      list: () => ({ records: [...records.values()], diagnostics: [] }),
      replace: (next: TaskRecord): void => { records.set(next.task_id, next) },
      mutate: (taskId: string, mutation: (current: TaskRecord) => TaskRecord): TaskRecord | null => {
        const current = records.get(taskId)
        if (current === undefined) return null
        const next = mutation(current)
        if (next !== current) records.set(taskId, next)
        return next
      },
      appendEvent: (_taskId: string, _event: PersistedTaskEvent): string => "log.jsonl",
    },
  }
}

function fakeNotifier(): { notifier: ParentNotifier; calls: ParentNotifierMessage[] } {
  const calls: ParentNotifierMessage[] = []
  return { notifier: { enqueue: (message) => calls.push(message) }, calls }
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "rubato-team-member-silence-"))
}

describe("team member turn end is silent to the lead", () => {
  test("#given a team member that completed a turn #when notifyTerminal runs #then nothing is enqueued and the epoch is stamped", () => {
    // given
    const member = record()
    const { store, records } = fakeStore([member])
    const { notifier, calls } = fakeNotifier()
    const completion = createCompletionNotifier({ notifier, store, stateDir: tempStateDir() })

    // when
    const result = completion.notifyTerminal({ record: member, parentState: { kind: "idle" }, runInBackground: true })

    // then
    expect(result).toEqual({ kind: "skipped", reason: "team-member-turn-end" })
    expect(calls).toHaveLength(0)
    expect(records.get(member.task_id)?.notification.notified_epoch).toBe(0)
  })

  test("#given a team member that completed a turn #when notifyTerminal runs #then its result body is still written to a file", () => {
    // given
    const stateDir = tempStateDir()
    const member = record()
    const { store } = fakeStore([member])
    const { notifier } = fakeNotifier()
    const completion = createCompletionNotifier({ notifier, store, stateDir })

    // when
    completion.notifyTerminal({ record: member, parentState: { kind: "idle" }, runInBackground: true })

    // then
    const path = join(stateDir, "completion-results", member.task_id, `${member.notification.run_epoch}.txt`)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("verdict: baseline hash matches")
  })

  test("#given a stamped member turn end #when reconcile runs in the same session #then it is not re-delivered", () => {
    // given
    const member = record()
    const { store } = fakeStore([member])
    const { notifier, calls } = fakeNotifier()
    const completion = createCompletionNotifier({ notifier, store, stateDir: tempStateDir() })
    completion.notifyTerminal({ record: member, parentState: { kind: "idle" }, runInBackground: true })

    // when
    completion.reconcileUnnotifiedNotifications({ sessionId: "lead-session", parentState: { kind: "idle" } })

    // then
    expect(calls).toHaveLength(0)
  })

  test("#given a team member that errored #when notifyTerminal runs #then the lead is still told", () => {
    // given: a failure must never become silence
    const member = record({ status: "error", final_response: undefined, error_message: "provider 500" })
    const { store } = fakeStore([member])
    const { notifier, calls } = fakeNotifier()
    const completion = createCompletionNotifier({ notifier, store, stateDir: tempStateDir() })

    // when
    const result = completion.notifyTerminal({ record: member, parentState: { kind: "idle" }, runInBackground: true })

    // then
    expect(result).toEqual({ kind: "delivered", decision: "wake" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.triggerTurn).toBe(true)
  })

  test("#given a member that was killed #when notifyTerminal runs #then the lead is still told", () => {
    // given
    const member = record({ status: "lost", final_response: undefined, error_message: "gone", killed: true })
    const { store } = fakeStore([member])
    const { notifier, calls } = fakeNotifier()
    const completion = createCompletionNotifier({ notifier, store, stateDir: tempStateDir() })

    // when
    completion.notifyTerminal({ record: member, parentState: { kind: "idle" }, runInBackground: true })

    // then
    expect(calls).toHaveLength(1)
  })

  test("#given an ordinary lead-spawned child #when it completes #then it still wakes the lead with its result path", () => {
    // given
    const child = record({ name: "summarize-logs", task_id: "st_child", parent_session_id: "lead-session" })
    const { store } = fakeStore([child])
    const { notifier, calls } = fakeNotifier()
    const completion = createCompletionNotifier({ notifier, store, stateDir: tempStateDir() })

    // when
    const result = completion.notifyTerminal({ record: child, parentState: { kind: "idle" }, runInBackground: true })

    // then
    expect(result).toEqual({ kind: "delivered", decision: "wake" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.content).toContain("completed summarize-logs st_child")
    expect(calls[0]?.content).toContain("result ")
    expect(calls[0]?.content).not.toContain("verdict: baseline hash matches")
  })

  test("#given a helper spawned by an owner #when it completes #then the notification targets the owner session", () => {
    // given: parent_session_id is the owner's session, not the lead's
    const helper = record({ name: "helper", task_id: "st_helper", parent_session_id: "owner-session" })
    const { store } = fakeStore([helper])
    const { notifier, calls } = fakeNotifier()
    const completion = createCompletionNotifier({
      notifier,
      store,
      stateDir: tempStateDir(),
      getCurrentSessionId: () => "owner-session",
    })

    // when
    completion.notifyTerminal({ record: helper, parentState: { kind: "idle" }, runInBackground: true })

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.content).toContain("st_helper")
  })
})
