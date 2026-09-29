import { describe, expect, test } from "bun:test"

import {
  createChildHandle,
  type ChildPendingWork,
  type ChildSession,
  type ChildSessionEvent,
  type ChildSessionListener,
  type RunnerOutcome,
} from "./child-handle"

const FAST_HOLD = { pollMs: 1, settleMs: 5, stuckDeliveryMs: 40 }

type HoldSessionControls = {
  readonly session: ChildSession
  readonly pending: { value: ChildPendingWork }
  readonly prompts: string[]
  readonly steers: string[]
  // The model answers the current run with this text and the run ends.
  endRun(text: string): void
  // A background completion wakes the idle session with a new run (monitor event, bash exit).
  wake(): void
}

// A session with the engine's idle/pending-work surface: prompt() opens a run that ends when the
// test ends it, and a wake opens a run on an idle session the way a triggerTurn notification does.
function createHoldSession(): HoldSessionControls {
  const listeners = new Set<ChildSessionListener>()
  const pending = { value: { active: 0, undelivered: 0 } as ChildPendingWork }
  const prompts: string[] = []
  const steers: string[] = []
  let busy = false
  let lastText: string | undefined
  let settlePrompt: (() => void) | undefined
  let idleWaiters: Array<() => void> = []
  const emit = (event: ChildSessionEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const endRun = (text: string): void => {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } })
    lastText = text
    busy = false
    const settle = settlePrompt
    settlePrompt = undefined
    settle?.()
    const waiters = idleWaiters
    idleWaiters = []
    for (const waiter of waiters) waiter()
  }
  const session: ChildSession = {
    sessionId: "child-session-hold",
    extensionRunner: {
      hasHandlers: () => false,
      emit: async () => undefined,
      pendingWork: async () => pending.value,
    },
    get isIdle() {
      return !busy
    },
    prompt(text: string) {
      prompts.push(text)
      busy = true
      return new Promise<void>((resolve) => {
        settlePrompt = resolve
      })
    },
    async steer(text: string) {
      steers.push(text)
    },
    async followUp() {},
    async abort() {},
    subscribe(listener: ChildSessionListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLastAssistantText: () => lastText,
    waitForIdle: () => (busy ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve()),
    dispose() {},
  }
  return { session, pending, prompts, steers, endRun, wake: () => void (busy = true) }
}

async function settledWithin(outcome: Promise<RunnerOutcome>, ms: number): Promise<RunnerOutcome | "pending"> {
  return Promise.race([outcome, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))])
}

describe("createChildHandle pending-work hold", () => {
  test("#given a turn that ends while its background check still runs #when the turn ends #then the run is not settled until the wake turn reports", async () => {
    // given a child that started a check in the background and ended its turn to wait for it
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "build and check", hold: FAST_HOLD })
    fake.pending.value = { active: 1, undelivered: 0 }
    fake.endRun("The checks are running; the report follows when they finish.")

    // when nothing has woken it yet
    // then the dispatcher is not handed the waiting line as a completion
    expect(await settledWithin(handle.waitForIdle(), 30)).toBe("pending")

    // when the check finishes and its notification wakes the child, which reports
    fake.wake()
    fake.pending.value = { active: 0, undelivered: 0 }
    fake.endRun("All checks pass.")
    const outcome = await handle.waitForIdle()

    // then the run completes once, with the report
    expect(outcome.status).toBe("completed")
    if (outcome.status !== "completed") throw new Error("expected completion")
    expect(outcome.finalResponse).toContain("All checks pass.")
  })

  test("#given a report followed by a late wake turn #when the run settles #then the report is still in the final response", async () => {
    // given a child that reported while one background run was still finishing
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "fetch", hold: FAST_HOLD })
    fake.pending.value = { active: 1, undelivered: 0 }
    fake.endRun("Report: 4,450 postings in 35s.")

    // when that run's exit notification wakes it and it only acknowledges the notice
    fake.wake()
    fake.pending.value = { active: 0, undelivered: 0 }
    fake.endRun("That notice is the same run; nothing changes.")
    const outcome = await handle.waitForIdle()

    // then the acknowledgement does not replace the report
    if (outcome.status !== "completed") throw new Error("expected completion")
    expect(outcome.finalResponse).toContain("Report: 4,450 postings in 35s.")
  })

  test("#given a turn with no pending work #when it ends #then the run settles with that turn's text alone", async () => {
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "answer", hold: FAST_HOLD })

    fake.endRun("done")

    expect(await handle.waitForIdle()).toEqual({ status: "completed", finalResponse: "done" })
  })

  test("#given a run held between turns #when the dispatcher steers it #then the message opens a new turn instead of sitting in the idle queue", async () => {
    // given a child idle between turns, waiting on its background work
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "work", hold: FAST_HOLD })
    fake.pending.value = { active: 1, undelivered: 0 }
    fake.endRun("Waiting on the build.")
    await new Promise((resolve) => setTimeout(resolve, 10))

    // when the dispatcher sends a message
    await handle.steer("Also report the bundle size.")

    // then it is delivered as a turn, and that turn's answer ends the run
    expect(fake.prompts).toEqual(["work", "Also report the bundle size."])
    expect(fake.steers).toEqual([])
    fake.pending.value = { active: 0, undelivered: 0 }
    fake.endRun("Build done; bundle is 386 kB.")
    const outcome = await handle.waitForIdle()
    if (outcome.status !== "completed") throw new Error("expected completion")
    expect(outcome.finalResponse).toContain("bundle is 386 kB")
  })

  test("#given a completion that never reaches the idle session #when the stuck-delivery limit passes #then the run settles instead of hanging", async () => {
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "work", hold: FAST_HOLD })
    fake.pending.value = { active: 0, undelivered: 1 }

    fake.endRun("Waiting on the monitor.")

    expect(await settledWithin(handle.waitForIdle(), 500)).toEqual({ status: "completed", finalResponse: "Waiting on the monitor." })
  })
})
