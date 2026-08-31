import {
  createChildProgress,
  runTaskCancel,
  runTaskOutput,
  runTaskSend,
  type ManagedChildEvent,
  type TaskRecord,
} from "@rubato/senpi-task"

import type { SenpiExtensionAPI } from "../../extension/types"
import type { TaskEngine } from "./engine"
import {
  boundedTaskOutput,
  invalidArguments,
  liveProgressSnapshot,
  parseTaskCancel,
  parseTaskOutput,
  parseTaskSend,
  taskSnapshot,
  type TaskLiveProgressSnapshot,
} from "./task-rpc-codec"

const TASK_UPDATED_EVENT = "rubato.task.updated"
const MAX_TASK_SNAPSHOTS = 256

export interface TaskRpcBridge {
  attach(): void
  sync(): void
  detach(): void
  dispose(): void
}

export function wireTaskRpcBridge(
  pi: SenpiExtensionAPI,
  engine: TaskEngine,
): TaskRpcBridge {
  const subscriptions = new Map<string, () => void>()
  const liveProgress = new Map<string, TaskLiveProgressSnapshot>()
  let activeSessionId: string | undefined
  let lastSnapshot: string | undefined
  let disposed = false

  const recordsForSession = (sessionId: string) => {
    const all = engine.manager.list({ scope: "parent-session", session_id: sessionId }).map((entry) => entry.record)
    const truncatedTasks = Math.max(0, all.length - MAX_TASK_SNAPSHOTS)
    if (truncatedTasks === 0) return { records: all, truncatedTasks }
    const live = all.filter(isLive).slice(-MAX_TASK_SNAPSHOTS)
    const terminalSlots = MAX_TASK_SNAPSHOTS - live.length
    return {
      records: [
        ...live,
        ...(terminalSlots === 0 ? [] : all.filter((record) => !isLive(record)).slice(-terminalSlots)),
      ],
      truncatedTasks,
    }
  }

  const emit = (selection = activeSessionId === undefined ? undefined : recordsForSession(activeSessionId)): void => {
    const sessionId = activeSessionId
    if (disposed || sessionId === undefined || pi.rpc?.emit === undefined) return
    if (selection === undefined) return
    const data = {
      parent_session_id: sessionId,
      tasks: selection.records.map((record) =>
        taskSnapshot(
          record,
          isLive(record) ? engine.manager.runStatsSnapshot?.(record.task_id) : undefined,
          liveProgress.get(record.task_id),
        ),
      ),
      ...(selection.truncatedTasks === 0 ? {} : { truncated_tasks: selection.truncatedTasks }),
    }
    const fingerprint = JSON.stringify(data)
    if (fingerprint === lastSnapshot) return
    lastSnapshot = fingerprint
    pi.rpc.emit(TASK_UPDATED_EVENT, data)
  }

  const removeSubscription = (taskId: string): void => {
    subscriptions.get(taskId)?.()
    subscriptions.delete(taskId)
    liveProgress.delete(taskId)
  }

  const syncSubscriptions = (records: readonly TaskRecord[]): void => {
    const liveIds = new Set(
      records
        .filter((record) => isLive(record) && record.residency_state === "resident")
        .map((record) => record.task_id),
    )
    for (const taskId of subscriptions.keys()) {
      if (!liveIds.has(taskId)) removeSubscription(taskId)
    }
    for (const record of records) {
      if (!liveIds.has(record.task_id) || subscriptions.has(record.task_id)) continue
      const progress = createChildProgress(
        record.task_id,
        {
          name: record.name,
          taskSummary: record.task_summary,
          description: record.description,
          category: record.category,
          agentType: record.agent_type,
          resolvedModel: record.resolved_model,
          model: record.model,
        },
        Date.parse(record.created_at),
      )
      const unsubscribe = engine.manager.subscribeChild(record.task_id, (event: ManagedChildEvent) => {
        if (!progress.accept(event)) return
        liveProgress.set(record.task_id, liveProgressSnapshot(progress.details()))
        emit()
      })
      subscriptions.set(record.task_id, unsubscribe)
    }
  }

  const detach = (): void => {
    for (const taskId of [...subscriptions.keys()]) removeSubscription(taskId)
    activeSessionId = undefined
    lastSnapshot = undefined
  }

  const sync = (): void => {
    const sessionId = activeSessionId
    if (sessionId === undefined || pi.rpc?.emit === undefined) return
    const selection = recordsForSession(sessionId)
    syncSubscriptions(selection.records)
    emit(selection)
  }

  registerTaskHandlers(pi, engine, () => (disposed ? undefined : activeSessionId))

  return {
    attach() {
      if (disposed) return
      detach()
      activeSessionId = engine.runtime.sessionId()
      sync()
    },
    sync,
    detach,
    dispose() {
      if (disposed) return
      disposed = true
      detach()
    },
  }
}

function registerTaskHandlers(
  pi: SenpiExtensionAPI,
  engine: TaskEngine,
  currentSessionId: () => string | undefined,
): void {
  const handle = pi.rpc?.handle
  if (handle === undefined) return
  handle("rubato.task.send", async (data) => {
    const sessionId = currentSessionId()
    if (sessionId === undefined) return unavailable()
    const input = parseTaskSend(data)
    if ("error" in input) return invalidArguments(input.error)
    const record = engine.manager.get(input.value.to)
    if (record === undefined || record.parent_session_id !== sessionId) return notFound()
    return toRpcChildControlDetails(
      (await runTaskSend(engine.manager, { agentId: input.value.to, message: input.value.message }, sessionId)).details,
    )
  })
  handle("rubato.task.cancel", async (data) => {
    const sessionId = currentSessionId()
    if (sessionId === undefined) return unavailable()
    const input = parseTaskCancel(data)
    if ("error" in input) return invalidArguments(input.error)
    const record = engine.manager.get(input.value.task_id)
    if (record === undefined || record.parent_session_id !== sessionId) return notFound()
    return toRpcChildControlDetails((await runTaskCancel(engine.manager, {
      agentId: input.value.task_id,
      ...(input.value.reason !== undefined ? { reason: input.value.reason } : {}),
    })).details)
  })
  handle("rubato.task.output", async (data) => {
    const sessionId = currentSessionId()
    if (sessionId === undefined) return unavailable()
    const input = parseTaskOutput(data)
    if ("error" in input) return invalidArguments(input.error)
    return boundedTaskOutput((
      await runTaskOutput(
        { manager: engine.manager, stateDir: engine.stateDir },
        {
          agentId: input.value.task_id,
          ...(input.value.mode === undefined ? {} : { mode: input.value.mode }),
          ...(input.value.tail_lines === undefined ? {} : { tail_lines: input.value.tail_lines }),
        },
        sessionId,
      )
    ).details)
  })
}

// Transitional Senpi RPC adapter: public child-control details use agentId, while the panel
// protocol still addresses children as task_id on rubato.task.* methods.
function toRpcChildControlDetails(details: { readonly kind: string; readonly agentId?: string; readonly known_agents?: readonly string[] }) {
  const { agentId, known_agents, ...rest } = details
  return {
    ...rest,
    ...(agentId === undefined ? {} : { task_id: agentId }),
    ...(known_agents === undefined ? {} : { known_tasks: known_agents }),
  }
}

function isLive(record: TaskRecord): boolean {
  return record.status === "pending" || record.status === "running"
}

function unavailable() {
  return { kind: "unavailable", reason: "No active parent session." } as const
}

function notFound() {
  return { kind: "not_found", reason: "Task not found." } as const
}
