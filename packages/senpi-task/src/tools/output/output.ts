import type { ToolDefinition } from "@code-yeongyu/senpi"
import type { AgentSnapshot } from "@rubato/agent-core"
import { Type } from "typebox"
import type { Static } from "typebox"

import { defaultResolveCallerSessionId, toolResult } from "../control"
import { createSenpiAgentHandle } from "../host/senpi-agent-host"
import { renderTaskOutputCall, renderTaskOutputResult } from "./renderers"
import { renderTranscript } from "./render"
import { defaultTranscriptReader } from "./transcript"
import type { TaskOutputDeps, TaskOutputDetails, TaskOutputToolResult, TranscriptReader } from "./types"

export const TaskOutputParams = Type.Object({
  agentId: Type.String({ description: "agentId of the child to read." }),
  mode: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("tail"), Type.Literal("full")], {
      description: "status (default) = host snapshot; tail = last lines of the transcript; full = whole transcript.",
    }),
  ),
  tail_lines: Type.Optional(
    Type.Integer({ minimum: 1, description: "Lines to keep in tail mode. Defaults to 60." }),
  ),
})

export type TaskOutputInput = Static<typeof TaskOutputParams>

const DEFAULT_TAIL_LINES = 60
const BLOCKING_REMOVED_GUIDANCE = 'blocking removed - completion arrives as a notification; use mode:"tail" to peek.'

const DESCRIPTION = [
  "Read one child agent, keyed by agentId. AgentOutput always returns immediately: mode='status' (default) returns the host snapshot, including the final output once terminal.",
  "mode='tail' returns the last tail_lines of the recorded transcript; mode='full' returns the whole transcript (capped, with a head/tail elision marker). Completion notifications already include the final result.",
  "READ-ONLY: this never revives, steers, or otherwise touches the child.",
  "Only the current session's children are visible.",
].join(" ")

export function runTaskOutput(
  deps: TaskOutputDeps,
  params: Partial<TaskOutputInput>,
  callerSessionId: string | undefined,
): Promise<TaskOutputToolResult> {
  if (hasLegacyBlockingParam(params)) return Promise.resolve(invalidArguments(BLOCKING_REMOVED_GUIDANCE))

  const agentId = params.agentId?.trim()
  if (agentId === undefined || agentId.length === 0) {
    return Promise.resolve(invalidArguments("agentId is required"))
  }
  if (callerSessionId === undefined) return Promise.resolve(notFound(agentId))

  return outputForHandle(deps, agentId, params, callerSessionId)
}

function hasLegacyBlockingParam(params: object): boolean {
  return Reflect.get(params, "block") !== undefined || Reflect.get(params, "timeout_ms") !== undefined
}

async function outputForHandle(
  deps: TaskOutputDeps,
  agentId: string,
  params: Partial<TaskOutputInput>,
  callerSessionId: string,
): Promise<TaskOutputToolResult> {
  // Pass the manager itself, as send/cancel do. Extracting `get` off a
  // TaskManagerImpl instance unbinds `this`, and its private `#tryLoad` then
  // fails the brand check ("Receiver must be an instance of class ...").
  const handle = createSenpiAgentHandle(deps.manager, agentId, { callerSessionId })
  let snapshot: AgentSnapshot
  try {
    snapshot = await handle.output()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No agent '")) return notFound(agentId)
    throw error
  }

  const mode = params.mode ?? "status"
  if (mode === "status" || snapshot.status === "lost") {
    return toolResult(statusText(snapshot), { kind: "status", snapshot })
  }

  const record = deps.manager.get(agentId)
  if (record === undefined) return notFound(agentId)
  return transcriptResult(deps, record.task_id, snapshot, mode, params.tail_lines ?? DEFAULT_TAIL_LINES)
}

function transcriptResult(
  deps: TaskOutputDeps,
  taskId: string,
  snapshot: AgentSnapshot,
  mode: "tail" | "full",
  tailLines: number,
): TaskOutputToolResult {
  const reader: TranscriptReader = deps.transcriptReader ?? defaultTranscriptReader
  const { entries, source, truncated: sourceTruncated } = reader({
    taskId,
    stateDir: deps.stateDir,
  })
  const rendered = renderTranscript(entries, { mode, tailLines })
  const details: TaskOutputDetails = {
    kind: "transcript",
    mode,
    source,
    transcript: rendered.text,
    truncated: rendered.truncated || sourceTruncated === true,
    snapshot,
  }
  return toolResult(`${snapshot.agentId} [${snapshot.status}] transcript via ${source}:\n${rendered.text}`, details)
}

function statusText(snapshot: AgentSnapshot): string {
  const parts = [`${snapshot.agentId} [${snapshot.status}]`]
  if (snapshot.model !== undefined) parts.push(`model ${snapshot.model}`)
  if (snapshot.effort !== undefined) {
    const source = snapshot.effortSource === undefined ? "" : ` (${snapshot.effortSource})`
    parts.push(`effort ${snapshot.effort}${source}`)
  }
  if (snapshot.output !== undefined) parts.push(snapshot.output)
  return parts.join("\n")
}

function notFound(agentId: string): TaskOutputToolResult {
  return toolResult(`No agent '${agentId}' in this session.`, {
    kind: "not_found",
    reason: `No agent '${agentId}' in this session.`,
    known_agents: [],
  })
}

function invalidArguments(reason: string): TaskOutputToolResult {
  return toolResult(reason, { kind: "invalid_arguments", reason })
}

export function createTaskOutputTool(deps: TaskOutputDeps): ToolDefinition<typeof TaskOutputParams, TaskOutputDetails> {
  const resolveCaller = deps.resolveCallerSessionId ?? defaultResolveCallerSessionId
  return {
    name: "AgentOutput",
    label: "Agent Output",
    description: DESCRIPTION,
    parameters: TaskOutputParams,
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => runTaskOutput(deps, params, resolveCaller(ctx)),
    renderCall: (args, theme) => renderTaskOutputCall(args, theme),
    renderResult: (result, options, theme) => renderTaskOutputResult(result, options, theme),
  }
}
