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
  // Messages a busy session queued to run after its current turn.
  readonly queued: string[]
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
  const queued: string[] = []
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
    // Like the engine, a run takes its queued follow-ups before it ends.
    const next = queued.shift()
    if (next !== undefined) {
      prompts.push(next)
      return
    }
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
    prompt(text: string, options?: { readonly streamingBehavior?: "steer" | "followUp" }) {
      if (busy) {
        if (options?.streamingBehavior === undefined) {
          return Promise.reject(new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."))
        }
        queued.push(text)
        return Promise.resolve()
      }
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
  return { session, pending, prompts, steers, queued, endRun, wake: () => void (busy = true) }
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

  test("#given a run held for background work #when the wake turn settles the run #then the handle stops reporting an active run", async () => {
    // given a child waiting between turns on its background measurement
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "measure", hold: FAST_HOLD })
    fake.pending.value = { active: 1, undelivered: 0 }
    fake.endRun("Measurements run in the background; I'll pick them up.")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(handle.isRunActive()).toBe(true)

    // when the measurement's exit wakes it and that turn ends the run
    fake.wake()
    fake.pending.value = { active: 0, undelivered: 0 }
    fake.endRun("The measurement failed: no space left on device.")
    await handle.waitForIdle()

    // then nothing reads a steer any more, and the handle says so
    expect(handle.isRunActive()).toBe(false)
  })

  test("#given a settled run and a turn its own monitor woke #when the dispatcher revives it #then the message follows that turn instead of failing as busy", async () => {
    // given a run that settled, then a late monitor event that woke the child on its own
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "export", hold: FAST_HOLD })
    fake.endRun("Exports done.")
    expect(await handle.waitForIdle()).toEqual({ status: "completed", finalResponse: "Exports done." })
    fake.wake()

    // when the dispatcher revives it while that turn runs
    await handle.followUp("Which renderer do you recommend?")

    // then the message waits for the woken turn and gets its own answer
    expect(fake.queued).toEqual(["Which renderer do you recommend?"])
    fake.endRun("Late batch result noted.")
    expect(fake.prompts).toEqual(["export", "Which renderer do you recommend?"])
    fake.endRun("Per-frame rendering.")
    const outcome = await handle.waitForIdle()
    if (outcome.status !== "completed") throw new Error(`expected completion, got ${JSON.stringify(outcome)}`)
    expect(outcome.finalResponse).toContain("Per-frame rendering.")
  })

  test("#given a settled run #when the child's own monitor wakes a turn and the run is adopted #then that turn's answer is the new run's outcome", async () => {
    // given the dispatcher already has the run's waiting line as its answer
    const fake = createHoldSession()
    const handle = createChildHandle({ taskId: "task-1", session: fake.session, promptText: "export batch", hold: FAST_HOLD })
    fake.endRun("First export done; waiting for the rest.")
    await handle.waitForIdle()
    expect(handle.isRunActive()).toBe(false)

    // when a late monitor event wakes the child and the manager adopts that turn
    fake.wake()
    handle.adoptRun()

    // then the turn is tracked and its report settles the adopted run
    expect(handle.isRunActive()).toBe(true)
    expect(fake.prompts).toEqual(["export batch"])
    fake.endRun("All five exports done; per-frame rendering wins.")
    expect(await handle.waitForIdle()).toEqual({ status: "completed", finalResponse: "All five exports done; per-frame rendering wins." })
    expect(handle.isRunActive()).toBe(false)
  })
})
