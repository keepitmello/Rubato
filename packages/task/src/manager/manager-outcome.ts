import { log } from "@rubato/utils"

import type { TaskRecord, TaskRunStats } from "../state"
import type { TaskRecordStore } from "../store"
import type { ManagedChildHandle } from "./child-handle"
import { nowIso } from "./manager-helpers"

export type ManagedOutcome = Awaited<ReturnType<ManagedChildHandle["waitForOutcome"]>>

export type ErrorOutcomeInput = {
  readonly taskId: string
  readonly handle: ManagedChildHandle
  readonly model: string
  readonly epoch: number
  readonly outcome: Extract<ManagedOutcome, { readonly status: "error" }>
  readonly runStats: TaskRunStats | undefined
  readonly timestamp: string
}

// Live manager state the tracker reads through, so every ownership verdict is computed from the
// freshest handles and the freshest on-disk record rather than facts captured when the tracking
// cycle was armed.
export type OutcomeTrackerPorts = {
  readonly store: TaskRecordStore
  readonly now: () => number
  readonly liveHandle: (taskId: string) => ManagedChildHandle | undefined
  readonly tryLoad: (taskId: string) => TaskRecord | null
  readonly runStatsSnapshot: (taskId: string) => TaskRunStats | undefined
  readonly releaseSlot: (taskId: string, model: string, epoch: number) => void
  readonly settleWaiters: (taskId: string) => void
  readonly tryRuntimeFallback: (input: ErrorOutcomeInput) => Promise<boolean>
  readonly sleep?: (ms: number) => Promise<void>
}

export type OutcomeTracker = {
  readonly trackOutcome: (taskId: string, handle: ManagedChildHandle, model: string, epoch: number) => void
}

// A settled outcome may only terminalize a run the manager STILL owns: the same live handle and
// the run_epoch the tracking cycle was armed under, with a record that is not suspended.
//
// Suspension forgets the handle BEFORE its abort settles ("stale outcome tracking loses ownership
// FIRST"), so the late cancelled/error outcome arrives after ownership is gone and must become a
// no-op - never a cancelled/error terminal on a suspended record. The production residency
// registry delegates forget() to manager.forget(), so ownership loss is the primary guard; the
// residency blocklist is the second wall for a record already persisted_only/rpc_detached whose
// outcome settles through a stale handle mapping.
//
// The blocklist is deliberate, NOT an allowlist of "resident": the dispose/evict teardown paths
// transition residency (disposed/evicted) while leaving status running, and the late outcome is
// the contracted path that terminalizes such a record - blocking it would strand a running record
// nobody can settle (chaos invariant 3 pins this drain behavior).
function ownsOutcome(
  ports: OutcomeTrackerPorts,
  taskId: string,
  handle: ManagedChildHandle,
  epoch: number,
): boolean {
  if (ports.liveHandle(taskId) !== handle) return false
  const fresh = ports.tryLoad(taskId)
  return (
    fresh !== null &&
    fresh.residency_state !== "persisted_only" &&
    fresh.residency_state !== "rpc_detached" &&
    fresh.notification.run_epoch === epoch
  )
}

const SETTLE_RETRY_FIRST_MS = 1_000
const SETTLE_RETRY_MAX_MS = 60_000

function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

export function createOutcomeTracker(ports: OutcomeTrackerPorts): OutcomeTracker {
  const sleep = ports.sleep ?? sleepUnref

  // A settled run whose record still says "running" looks alive: AgentSend steers into the idle
  // session and nobody reads the message. The write can fail for a while (a full disk), so it is
  // retried until it lands or the run has moved on to another owner or epoch.
  async function persistSettlement(
    taskId: string,
    handle: ManagedChildHandle,
    epoch: number,
    write: () => void,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        write()
        return
      } catch (error) {
        const delayMs = Math.min(SETTLE_RETRY_FIRST_MS * 2 ** attempt, SETTLE_RETRY_MAX_MS)
        log("senpi-task manager outcome write failed; retrying", { taskId, attempt, delayMs, error: String(error) })
        await sleep(delayMs)
        if (!ownsOutcome(ports, taskId, handle, epoch)) return
      }
    }
  }

  async function settleErrorOutcome(input: ErrorOutcomeInput): Promise<void> {
    if (await ports.tryRuntimeFallback(input)) return
    // Re-checked after the fallback await: ownership may have moved on while it ran.
    if (!ownsOutcome(ports, input.taskId, input.handle, input.epoch)) return

    ports.releaseSlot(input.taskId, input.model, input.epoch)
    await persistSettlement(input.taskId, input.handle, input.epoch, () => {
      ports.store.transition(input.taskId, {
        type: "fail",
        timestamp: input.timestamp,
        error_message: input.outcome.failure.message,
        ...(input.outcome.killed === true ? { killed: true } : {}),
        ...(input.runStats === undefined ? {} : { run_stats: input.runStats }),
      })
    })
    ports.settleWaiters(input.taskId)
  }

  function trackOutcome(taskId: string, handle: ManagedChildHandle, model: string, epoch: number): void {
    handle
      .waitForOutcome()
      .then(async (outcome) => {
        if (!ownsOutcome(ports, taskId, handle, epoch)) return
        const timestamp = nowIso(ports.now)
        const runStats = ports.runStatsSnapshot(taskId)
        if (outcome.status === "error") {
          void settleErrorOutcome({
            taskId,
            handle,
            model,
            epoch,
            outcome,
            runStats,
            timestamp,
          }).catch((error: unknown) => {
            log("senpi-task manager error outcome tracking failed", {
              taskId,
              error: String(error),
            })
          })
          return
        }

        ports.releaseSlot(taskId, model, epoch)
        const runStatsField = runStats === undefined ? {} : { run_stats: runStats }
        await persistSettlement(taskId, handle, epoch, () => {
          if (outcome.status === "completed") {
            ports.store.transition(taskId, { type: "complete", timestamp, final_response: outcome.finalResponse, ...runStatsField })
          } else {
            ports.store.transition(taskId, { type: "cancel", timestamp, ...runStatsField })
          }
        })
        ports.settleWaiters(taskId)
      })
      .catch((error: unknown) => log("senpi-task manager outcome tracking failed", { taskId, error: String(error) }))
  }

  return { trackOutcome }
}
