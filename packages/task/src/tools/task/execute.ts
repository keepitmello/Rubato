import type { AgentError, AgentHost, ResolvedAgentSpec } from "@rubato/agent-core"
import { resolveAgentRequest } from "@rubato/agent-core"
import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi"

import { createSenpiAgentHost } from "../host/senpi-agent-host"
import { agentPresetCatalog, closedModelCatalog } from "./catalogs"
import type { TaskToolParamsStatic } from "./params"
import { startedDetails } from "./result-details"
import { evaluateSpawnPolicy } from "./spawn-policy"
import { backgroundStartText } from "./start-presentation"
import type { TaskToolContext, TaskToolDeps, TaskToolDetails } from "./types"

type TaskExecute = (
  toolCallId: string,
  params: TaskToolParamsStatic,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined,
  ctx: TaskToolContext,
) => Promise<AgentToolResult<TaskToolDetails>>

function result(text: string, details: TaskToolDetails): AgentToolResult<TaskToolDetails> {
  return { content: [{ type: "text", text }], details }
}

function invalidArguments(message: string, status = "invalid_arguments"): AgentToolResult<TaskToolDetails> {
  return result(message, { agentId: "", status, mode: "spawn", reason: message })
}

export function buildTaskExecute(deps: TaskToolDeps): TaskExecute {
  return async (_toolCallId, params, signal, _onUpdate, ctx) => {
    if (signal?.aborted) {
      const reason = "Parent aborted before spawn"
      return result(reason, { agentId: "", status: "cancelled", mode: "spawn", reason })
    }

    const catalogs = {
      models: deps.models ?? closedModelCatalog(),
      presets: agentPresetCatalog(deps.agents),
    }
    const resolved = resolveAgentRequest({
      prompt: params.prompt,
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.preset === undefined ? {} : { preset: params.preset }),
      ...(params.effort === undefined ? {} : { effort: params.effort }),
      ...(params.summary === undefined ? {} : { summary: params.summary }),
    }, catalogs)
    if (!resolved.ok) return invalidArguments(resolved.error.message, resolved.error.code)

    let spec = resolved.value
    if (spec.preset !== undefined) {
      const policy = evaluateSpawnPolicy(deps, spec.preset, spec.prompt, ctx.sessionManager.getSessionId())
      if (policy.kind === "deny") {
        return result(policy.message, { agentId: "", status: "denied", mode: "spawn", reason: policy.message })
      }
      if (policy.kind === "force") spec = { ...spec, prompt: policy.prompt }
    }

    const host = deps.host ?? hostFromDeps(deps, ctx)
    try {
      const handle = await host.spawn(spec)
      return spawnedResult(deps, spec, handle.agentId)
    } catch (error) {
      return spawnFailure(error)
    }
  }
}

function hostFromDeps(deps: TaskToolDeps, ctx: TaskToolContext): AgentHost {
  const parentSessionId = () => ctx.sessionManager.getSessionId()
  return createSenpiAgentHost({
    manager: deps.manager,
    models: deps.models ?? closedModelCatalog(),
    parentSessionId,
    depth: () => (deps.resolveAncestry?.(parentSessionId())?.depth ?? 0) + 1,
    rootSessionId: () => deps.resolveAncestry?.(parentSessionId())?.rootSessionId ?? parentSessionId(),
    agents: deps.agents,
    rubatoConfig: deps.rubatoConfig,
  })
}

function spawnedResult(
  deps: TaskToolDeps,
  spec: ResolvedAgentSpec,
  agentId: string,
): AgentToolResult<TaskToolDetails> {
  const record = deps.manager.get(agentId)
  const status: "pending" | "running" = record?.status === "pending" ? "pending" : "running"
  const name = record?.name ?? agentId
  const started = {
    kind: "started" as const,
    task_id: agentId,
    status,
    name,
    ...(record?.resolved_model === undefined ? {} : { resolved_model: record.resolved_model }),
  }
  return result(
    backgroundStartText(started, { taskSummary: spec.summary }),
    startedDetails(started, {
      prompt: spec.prompt,
      ...(spec.summary === undefined ? {} : { summary: spec.summary }),
      ...(spec.preset === undefined ? {} : { preset: spec.preset }),
      ...(spec.preset === undefined ? { model: spec.model } : {}),
    }, record?.execution_mode === "process" ? "process" : "in-process"),
  )
}

function spawnFailure(error: unknown): AgentToolResult<TaskToolDetails> {
  const code = isAgentError(error) ? error.code : "invalid_request"
  const message = error instanceof Error ? error.message : "Agent spawn failed"
  return result(message, { agentId: "", status: code, mode: "spawn", reason: message })
}

function isAgentError(error: unknown): error is AgentError & Error {
  return error instanceof Error && "code" in error && (
    error.code === "invalid_request" || error.code === "model_unavailable" || error.code === "preset_unavailable"
  )
}
