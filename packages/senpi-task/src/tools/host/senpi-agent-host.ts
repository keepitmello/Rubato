import type {
  AgentEvent,
  AgentEventListener,
  AgentHandle,
  AgentHost,
  AgentSnapshot,
  AgentStatus,
  ModelCatalog,
  ResolvedAgentSpec,
  Unsubscribe,
} from "@rubato/agent-core"
import type { RubatoConfig } from "@rubato/config-core"

import type { AgentDefinition } from "../../agents"
import { resolveExecutionMode, type ExecutionMode, type ManagerStartSpec, type TaskManager } from "../../manager"
import type { TaskRecord, TaskStatus } from "../../state"
import type { CancelOutcome, SendOutcome } from "../../steering"

export type SenpiAgentHandleManager = Pick<TaskManager, "sendToTask" | "cancelTask" | "get" | "subscribeChild">

export type SenpiAgentHostOptions = {
  readonly manager: Pick<TaskManager, "start"> & SenpiAgentHandleManager
  readonly models: ModelCatalog
  readonly parentSessionId: () => string
  readonly depth?: number | (() => number)
  readonly rootSessionId?: () => string
  readonly agents?: Readonly<Record<string, AgentDefinition>>
  readonly rubatoConfig?: RubatoConfig
}

export type SenpiAgentHandle = AgentHandle & {
  sendChild(message: string): Promise<SendOutcome>
  cancelChild(reason?: string): Promise<CancelOutcome>
}

export type SenpiAgentHandleOptions = {
  readonly callerSessionId?: string
  readonly allScope?: boolean
}

export function liveModelCatalog(
  resolveRegistry: () => { getAvailable?: () => unknown } | undefined,
): ModelCatalog {
  return {
    has(model) {
      const registry = resolveRegistry()
      if (registry === undefined || typeof registry.getAvailable !== "function") return false
      const slash = model.indexOf("/")
      if (slash <= 0) return false
      const provider = model.slice(0, slash)
      const modelId = model.slice(slash + 1)
      try {
        const available = registry.getAvailable()
        if (!Array.isArray(available)) return false
        return available.some((entry: { provider?: string; id?: string } | null | undefined) => (
          entry?.provider === provider && entry?.id === modelId
        ))
      } catch {
        return false
      }
    },
  }
}

export function createSenpiAgentHost(options: SenpiAgentHostOptions): AgentHost {
  return {
    models: () => options.models,
    spawn: async (spec) => {
      const started = await options.manager.start(startSpecFromResolved(spec, options))
      if (started.kind === "plan_unresolved" && started.error.code === "model_unavailable") {
        throw Object.assign(new Error(started.error.message), { code: "model_unavailable" as const, model: spec.model })
      }
      if (started.kind !== "started") {
        const message = startFailureMessage(started)
        throw Object.assign(new Error(message), { code: "invalid_request" as const })
      }
      return createSenpiAgentHandle(options.manager, started.task_id)
    },
  }
}

export function createSenpiAgentHandle(
  manager: Partial<SenpiAgentHandleManager> & Pick<SenpiAgentHandleManager, never> & {
    sendToTask?: TaskManager["sendToTask"]
    cancelTask?: TaskManager["cancelTask"]
    get?: TaskManager["get"]
    subscribeChild?: TaskManager["subscribeChild"]
  },
  agentId: string,
  handleOptions: SenpiAgentHandleOptions = {},
): SenpiAgentHandle {
  const sendChild = async (message: string): Promise<SendOutcome> => {
    if (manager.sendToTask === undefined) throw new Error("sendToTask is not available")
    return manager.sendToTask({
      idOrName: agentId,
      message,
      deliverAs: "steer",
      ...(handleOptions.callerSessionId !== undefined ? { callerSessionId: handleOptions.callerSessionId } : {}),
      ...(handleOptions.allScope === true ? { allScope: true } : {}),
    })
  }
  const cancelChild = async (reason?: string): Promise<CancelOutcome> => {
    if (manager.cancelTask === undefined) throw new Error("cancelTask is not available")
    return manager.cancelTask(agentId, reason)
  }
  return {
    agentId,
    sendChild,
    cancelChild,
    send: async (message) => {
      const outcome = await sendChild(message)
      switch (outcome.kind) {
        case "steered":
        case "revived":
        case "queued":
        case "capacity_deferred":
          return
        case "one_shot_agent":
          throw new Error(outcome.message)
        default:
          throw new Error(outcome.reason)
      }
    },
    output: async () => snapshotOf(manager, agentId, handleOptions),
    cancel: async () => {
      const outcome = await cancelChild()
      if (outcome.kind === "not_found") throw new Error(outcome.reason)
    },
    subscribe: (listener) => subscribe(manager, agentId, listener),
  }
}

export function startSpecFromResolved(spec: ResolvedAgentSpec, options: SenpiAgentHostOptions): ManagerStartSpec {
  const parentSessionId = options.parentSessionId()
  const depth = typeof options.depth === "function" ? options.depth() : (options.depth ?? 1)
  const preset = spec.preset
  return {
    prompt: spec.prompt,
    parent_session_id: parentSessionId,
    root_session_id: options.rootSessionId?.() ?? parentSessionId,
    depth,
    run_in_background: true,
    execution_mode: executionModeFor(spec, options),
    ...(preset === undefined ? { model: spec.model } : { subagent_type: preset }),
    ...(spec.effortSource === "manual-override" && spec.effort !== undefined ? { reasoning: spec.effort } : {}),
    ...(spec.summary === undefined ? {} : { task_summary: spec.summary }),
    ...(preset === undefined && spec.instructions !== undefined ? { instructions: spec.instructions } : {}),
  }
}

function executionModeFor(spec: ResolvedAgentSpec, options: SenpiAgentHostOptions): ExecutionMode {
  const preset = spec.preset
  const agentMode = preset === undefined ? undefined : toExecutionMode(
    options.agents?.[preset]?.executionMode ?? options.rubatoConfig?.agents?.[preset]?.execution_mode,
  )
  return resolveExecutionMode({
    ...(agentMode === undefined ? {} : { agentMode }),
    configMode: options.rubatoConfig?.task?.default_execution_mode,
  })
}

function toExecutionMode(value: string | undefined): ExecutionMode | undefined {
  return value === "in-process" || value === "process" ? value : undefined
}

function subscribe(
  manager: { subscribeChild?: TaskManager["subscribeChild"]; get?: TaskManager["get"] },
  agentId: string,
  listener: AgentEventListener,
): Unsubscribe {
  listener({ type: "started", agentId })
  if (manager.subscribeChild === undefined) return () => {}
  return manager.subscribeChild(agentId, () => {
    const record = manager.get?.(agentId)
    if (record === undefined) return
    listener(eventFor(record))
  })
}

function snapshotOf(
  manager: { get?: TaskManager["get"] },
  agentId: string,
  handleOptions: SenpiAgentHandleOptions = {},
): AgentSnapshot {
  const record = manager.get?.(agentId)
  if (record === undefined) throw new Error(`No agent '${agentId}'`)
  if (
    handleOptions.callerSessionId !== undefined &&
    record.parent_session_id !== handleOptions.callerSessionId
  ) {
    throw new Error(`No agent '${agentId}'`)
  }
  return snapshotFromRecord(record)
}

function snapshotFromRecord(record: TaskRecord): AgentSnapshot {
  const status = mapStatus(record.status)
  const effort = record.resolved_model?.reasoning_effort
  return {
    agentId: record.task_id,
    status,
    model: record.resolved_model === undefined ? record.model : `${record.resolved_model.provider}/${record.resolved_model.model_id}`,
    ...(isEffort(effort)
      ? {
          effort,
          effortSource:
            record.resolved_model?.effortSource === "manual-override" || record.resolved_model?.source === "explicit"
              ? "manual-override"
              : "model-default",
        }
      : {}),
    ...(record.final_response === undefined ? {} : { output: record.final_response }),
  }
}

function eventFor(record: TaskRecord): AgentEvent {
  const snapshot = snapshotFromRecord(record)
  if (snapshot.status === "completed") return { type: "completed", agentId: record.task_id, snapshot }
  if (snapshot.status === "failed") {
    return {
      type: "failed",
      agentId: record.task_id,
      error: { code: "invalid_request", message: record.error_message ?? "agent failed" },
    }
  }
  if (snapshot.status === "cancelled") return { type: "cancelled", agentId: record.task_id }
  return { type: "updated", agentId: record.task_id, snapshot }
}

function mapStatus(status: TaskStatus): AgentStatus {
  if (status === "error" || status === "interrupted") return "failed"
  return status
}

function isEffort(value: string | undefined): value is AgentSnapshot["effort"] {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
}

function startFailureMessage(started: Awaited<ReturnType<SenpiAgentHostOptions["manager"]["start"]>>): string {
  switch (started.kind) {
    case "plan_unresolved":
      return started.error.message
    case "depth_denied":
    case "residency_denied":
      return started.reason
    case "start_failed":
      return started.error_message
    default:
      return "Agent spawn failed"
  }
}
