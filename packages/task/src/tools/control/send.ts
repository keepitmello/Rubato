import { defineTool, type ToolDefinition } from "@code-yeongyu/senpi"

import { createSenpiAgentHandle } from "../host/senpi-agent-host"
import { defaultResolveCallerSessionId } from "./caller-session"
import { renderMemberScopedTaskSendCall, renderTaskSendCall, renderTaskSendResult } from "./renderers"
import { invalidArguments, mapSendOutcome, notFound } from "./send-results"
import { MemberScopedTaskSendParams, TaskSendParams } from "./send-schema"
import type { MemberScopedTaskSendInput, TaskSendInput } from "./send-schema"
import type { CallerSessionResolver, SendManager, SendResultDetails, SendToolResult } from "./types"
export { MemberScopedTaskSendParams, TaskSendParams } from "./send-schema"
export type { MemberScopedTaskSendInput, TaskSendInput } from "./send-schema"
export type { DefaultTeamRunIdResolution, TaskSendTeamRouting } from "./send-shutdown"

const DESCRIPTION = [
  "Send a follow-up instruction to a child agent, keyed by agentId.",
  "Plain-text messages always steer a running child immediately.",
  "A plain-text message to a finished resident child revives that same session; disposed, evicted, cancelled, and terminal-errored children are not revived.",
  "One-shot agents (momus) always refuse AgentSend in every state; spawn a new momus instead.",
].join(" ")

export type TaskSendDeps = {
  readonly manager: SendManager
  readonly resolveCallerSessionId?: CallerSessionResolver
}

export async function runTaskSend(
  manager: SendManager,
  params: Partial<TaskSendInput>,
  callerSessionId: string | undefined,
): Promise<SendToolResult> {
  const agentId = params.agentId?.trim()
  if (agentId === undefined || agentId.length === 0) return invalidArguments("agentId is required")
  if (typeof params.message !== "string") return invalidArguments("message is required")

  const handle = createSenpiAgentHandle(manager, agentId, {
    ...(callerSessionId !== undefined ? { callerSessionId } : {}),
  })
  const outcome = await handle.sendChild(params.message)
  if (outcome.kind !== "not_found") return mapSendOutcome(outcome)
  return notFound(manager, outcome.reason, callerSessionId)
}

export function createTaskSendTool(deps: TaskSendDeps): ToolDefinition<typeof TaskSendParams, SendResultDetails> {
  const resolveCaller = deps.resolveCallerSessionId ?? defaultResolveCallerSessionId
  return {
    name: "AgentSend",
    label: "Agent Send",
    description: DESCRIPTION,
    parameters: TaskSendParams,
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => runTaskSend(deps.manager, params, resolveCaller(ctx)),
    renderCall: (args, theme) => renderTaskSendCall(args, theme),
    renderResult: (result, options, theme) => renderTaskSendResult(result, options, theme),
  }
}

export type MemberScopedTaskSendDeps = TaskSendDeps

export function createMemberScopedTaskSendTool(deps: MemberScopedTaskSendDeps) {
  const resolveCaller = deps.resolveCallerSessionId ?? defaultResolveCallerSessionId
  return defineTool<typeof MemberScopedTaskSendParams, SendResultDetails>({
    name: "AgentSend",
    label: "Agent Send",
    description: DESCRIPTION,
    parameters: MemberScopedTaskSendParams,
    execute: (_toolCallId, params: MemberScopedTaskSendInput, _signal, _onUpdate, ctx) =>
      runTaskSend(deps.manager, params, resolveCaller(ctx)),
    renderCall: (args, theme) => renderMemberScopedTaskSendCall(args, theme),
    renderResult: (result, options, theme) => renderTaskSendResult(result, options, theme),
  })
}
