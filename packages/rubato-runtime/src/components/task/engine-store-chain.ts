import type { CompletionNotifier, TaskRecord, TaskRecordStore } from "@rubato/senpi-task"

import { createCompletionObservingStore } from "./completion-bridge"
import type { TaskRuntimeContext } from "./runtime-context"
import { createMutationNotifyingStore } from "./store-mutation-observer"
import type { TaskTerminalObservers } from "./terminal-observers"

export interface TaskStoreChainDeps {
  readonly baseStore: TaskRecordStore
  readonly runtime: TaskRuntimeContext
  readonly notifier: CompletionNotifier
  readonly terminal: {
    readonly wasBackground: (taskId: string) => boolean
    readonly notifyOwnedMemberLiveness: (record: TaskRecord) => void
    readonly observers: TaskTerminalObservers
  }
}

export interface TaskStoreChain {
  readonly store: TaskRecordStore
  /** Subscribe to every record mutation (spawn/transition/replace/remove). Returns an unsubscribe. */
  readonly onMutation: (listener: () => void) => () => void
}

/**
 * The task record store wrapper chain, innermost first:
 * 1. completion-observing - terminal TRANSITIONS drive parent notification and member liveness (F7);
 * 2. mutation-notifying - the debounced UI sync plus the terminal status-edge ledger, which is the
 *    only layer that also sees the `lost` writes reconciliation makes through replace/mutate.
 */
export function createTaskStoreChain(deps: TaskStoreChainDeps): TaskStoreChain {
  const observing = createCompletionObservingStore(deps.baseStore, {
    notifier: deps.notifier,
    parentState: () => deps.runtime.parentState(),
    wasBackground: deps.terminal.wasBackground,
    onTerminal: deps.terminal.notifyOwnedMemberLiveness,
  })
  const listeners = new Set<() => void>()
  const store = createMutationNotifyingStore(observing, () => {
    for (const listener of listeners) listener()
  }, deps.terminal.observers)
  return {
    store,
    onMutation: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
