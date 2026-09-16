import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi"
import { Type } from "typebox"
import type { Static } from "typebox"

import { TASK_SUMMARY_MAX_LENGTH } from "../../task-summary"
import { SenpiTeamRuntimeError, SenpiTeamSpecError } from "../../team"
import type { CreatedMemberInfo } from "../../team"
import type { ResolvedModelRecord } from "../../state"
import { formatTargetWithModel } from "../../status-line"
import { toolResult } from "../control"
import { TaskToolEffort } from "../task/params"
import type { TeamToolDeps, TeamToolsService } from "./types"

type AvailableModels = readonly string[] | (() => readonly string[])

function teamMemberModelSchema(availableModels: AvailableModels) {
  const schema = Type.String({
    description: "Complete provider/model id from the same live host registry used by Agent. Unknown models fail closed.",
  })
  if (typeof availableModels !== "function" && availableModels.length > 0) {
    Object.defineProperty(schema, "enum", { enumerable: true, value: [...availableModels].sort() })
  }
  return schema
}

function inlineTeamSpecMemberSchema(availableModels: AvailableModels) {
  return Type.Object(
    {
      name: Type.Optional(Type.String({ description: "Member name; unique within the team, lowercase-stem normalized." })),
      kind: Type.Union([Type.Literal("owner"), Type.Literal("verifier")], {
        description: "Taskforce role. Owners hold one bounded outcome; verifiers independently judge results and acceptance criteria.",
      }),
      model: teamMemberModelSchema(availableModels),
      effort: Type.Optional(TaskToolEffort),
      prompt: Type.String({ description: "Member instructions; MUST be written in English." }),
      task_summary: Type.Optional(
        Type.String({
          maxLength: TASK_SUMMARY_MAX_LENGTH,
          description: "One-line summary of this member's assigned work, shown in the task footer/widget UI. Longer values are force-truncated to 80 chars.",
        }),
      ),
    },
    { additionalProperties: false },
  )
}

function inlineTeamSpecSchema(availableModels: AvailableModels) {
  const memberSchema = inlineTeamSpecMemberSchema(availableModels)
  return Type.Object(
    {
      name: Type.Optional(Type.String({ description: "Team name; defaults to a derived inline name when omitted." })),
      members: Type.Array(memberSchema, {
        minItems: 1,
        maxItems: 8,
        description: "Team members with an explicit owner or verifier kind. The current session is always the lead; do not declare a lead member.",
      }),
    },
    { additionalProperties: false },
  )
}

export function buildTeamCreateParams(availableModels: AvailableModels = []) {
  const schema = Type.Object({
    team_name: Type.Optional(
      Type.String({ description: "Named team spec (project .rubato/teams or rubato.json) to create. Ignored when inline_spec is also provided." }),
    ),
    inline_spec: Type.Optional(
      Type.Union([inlineTeamSpecSchema(availableModels), Type.String({ description: "The same spec as a JSON string; parsed automatically. Passing the object form is preferred." })], {
        description: "Inline team spec, e.g. { name, members: [{ name, kind: 'owner'|'verifier', model, effort?, prompt }] }. Members use the same live model catalog as Agent. A JSON string of the same object is also accepted and parsed automatically. Takes precedence when team_name is also provided.",
      }),
    ),
  })
  if (typeof availableModels === "function") {
    const model = schema.properties.inline_spec.anyOf[0].properties.members.items.properties.model
    Object.defineProperty(model, "enum", {
      enumerable: true,
      get: () => {
        const values = availableModels()
        return values.length === 0 ? undefined : [...values].sort()
      },
    })
  }
  return schema
}

export const TeamCreateParams = buildTeamCreateParams()

export const TeamDeleteParams = Type.Object({
  team_run_id: Type.String({ description: "Team run id to delete." }),
  force: Type.Optional(Type.Boolean({ description: "Tear the run down even while members are still active." })),
})

export type TeamCreateInput = Static<typeof TeamCreateParams>
export type TeamDeleteInput = Static<typeof TeamDeleteParams>

export type TeamCreateMemberView = {
  readonly name: string
  readonly status: string
  readonly role: string
  readonly task_id: string
  readonly model?: ResolvedModelRecord
  readonly prompt_excerpt?: string
  readonly task_summary?: string
}

export type TeamCreateDetails =
  | { readonly kind: "created"; readonly team_run_id: string; readonly team_name: string; readonly members: readonly TeamCreateMemberView[] }
  | { readonly kind: "invalid_arguments"; readonly reason: string }
  | { readonly kind: "spec_error"; readonly code: string; readonly reason: string }
  | { readonly kind: "runtime_error"; readonly code: string; readonly reason: string }

export type TeamDeleteDetails =
  | { readonly kind: "deleted"; readonly team_run_id: string; readonly cancelled_task_ids: readonly string[] }
  | { readonly kind: "invalid_state"; readonly team_run_id: string; readonly code: string; readonly reason: string }

const CREATE_DESCRIPTION = [
  "Create a team run from a named spec or an inline spec. The current session is the team lead.",
  "Pass inline_spec for an ad hoc team or team_name for a named spec; inline_spec takes precedence when both are provided. Members run as background children; you coordinate them with the other team_* tools.",
  "Returns invalid_arguments for malformed input, spec_error for invalid specs, and runtime_error for spawn/bounds failures.",
  "Before choosing the execution shape, read the installed agent-taskforce skill and its Pi adapter. Investigate available facts, resolve the intent, and present its readable summary with the minimal model/role roster. Wait for explicit confirmation of both intent and roster before calling. Carry the newly accepted intent_ref in member briefs. This tool does not load skills or enforce human approval for you.",
].join(" ")

const DELETE_DESCRIPTION = "Delete a team run and cancel its members (terminal, not resumable). Lead-only. Pass force=true to tear it down while members are still active."

function coerceInlineSpec(input: unknown): { readonly ok: true; readonly spec: unknown } | { readonly ok: false; readonly reason: string } {
  if (typeof input !== "string") return { ok: true, spec: input }
  try {
    return { ok: true, spec: JSON.parse(input) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: `inline_spec is a string that is not valid JSON (${detail}). Pass the spec as a nested object like { name, members: [{ name, kind: "owner"|"verifier", model, effort?, prompt }] }, or as a valid JSON string of that object.`,
    }
  }
}

export async function runTeamCreate(service: TeamToolsService, params: TeamCreateInput): Promise<AgentToolResult<TeamCreateDetails>> {
  const hasName = params.team_name !== undefined && params.team_name.length > 0
  const hasInline = params.inline_spec !== undefined
  if (!hasName && !hasInline) {
    return toolResult("Provide team_name or inline_spec.", { kind: "invalid_arguments", reason: "provide team_name or inline_spec" })
  }

  let inlineSpec: unknown
  if (hasInline) {
    const coerced = coerceInlineSpec(params.inline_spec)
    if (!coerced.ok) {
      return toolResult(coerced.reason, { kind: "invalid_arguments", reason: coerced.reason })
    }
    inlineSpec = coerced.spec
  }

  try {
    const result = await service.createTeam(
      hasInline ? { inlineSpec } : { teamName: params.team_name },
    )
    const state = result.runtimeState
    const members: TeamCreateMemberView[] = result.members.map((member) => ({
      name: member.name,
      status: member.status,
      role: formatMemberRole(member.role),
      task_id: member.taskId,
      ...(member.model !== undefined ? { model: member.model } : {}),
      ...(member.promptExcerpt !== undefined ? { prompt_excerpt: member.promptExcerpt } : {}),
      ...(member.taskSummary !== undefined ? { task_summary: member.taskSummary } : {}),
    }))
    const lines = [
      `Created team '${state.teamName}' (${state.teamRunId}) with ${members.length} members.`,
      ...result.members.map((member) => formatCreatedMemberLine(member)),
    ]
    return toolResult(
      lines.join("\n"),
      { kind: "created", team_run_id: state.teamRunId, team_name: state.teamName, members },
    )
  } catch (error) {
    if (error instanceof SenpiTeamSpecError) return toolResult(error.message, { kind: "spec_error", code: error.code, reason: error.message })
    if (error instanceof SenpiTeamRuntimeError) return toolResult(error.message, { kind: "runtime_error", code: error.code, reason: error.message })
    throw error
  }
}

export async function runTeamDelete(service: TeamToolsService, params: TeamDeleteInput): Promise<AgentToolResult<TeamDeleteDetails>> {
  try {
    const result = await service.deleteTeam({ teamRunId: params.team_run_id, force: params.force })
    const cancelled = result.cancelledTaskIds
    const suffix = cancelled.length === 0 ? "" : `: ${cancelled.join(", ")}`
    return toolResult(
      `Deleted team ${result.teamRunId}; cancelled ${cancelled.length} member task(s)${suffix}.`,
      { kind: "deleted", team_run_id: result.teamRunId, cancelled_task_ids: result.cancelledTaskIds },
    )
  } catch (error) {
    if (error instanceof SenpiTeamRuntimeError) {
      return toolResult(error.message, { kind: "invalid_state", team_run_id: params.team_run_id, code: error.code, reason: error.message })
    }
    throw error
  }
}

function formatMemberRole(role: CreatedMemberInfo["role"]): string {
  return role.kind
}

// Prompt excerpts stay in details, never in the text lines: echoing raw member prompts into the
// lead conversation lets their content spoof scanners that match markers in the message stream
// (e2e role detection, keyword triggers).
function formatCreatedMemberLine(member: CreatedMemberInfo): string {
  const target = formatTargetWithModel({
    model: member.role.model,
    resolvedModel: member.model,
  })
  const model = target === undefined ? "" : ` ${target}`
  return `- ${member.name} [${member.status}] ${formatMemberRole(member.role)}${model} task:${member.taskId}`
}

export function createTeamCreateTool(deps: TeamToolDeps): ToolDefinition {
  const parameters = buildTeamCreateParams(() => deps.models?.list?.() ?? [])
  return {
    name: "team_create",
    label: "Team Create",
    description: CREATE_DESCRIPTION,
    parameters,
    execute: (_toolCallId: string, params: TeamCreateInput) => runTeamCreate(deps.service, params),
  }
}

export function createTeamDeleteTool(deps: TeamToolDeps): ToolDefinition {
  return {
    name: "team_delete",
    label: "Team Delete",
    description: DELETE_DESCRIPTION,
    parameters: TeamDeleteParams,
    execute: (_toolCallId: string, params: TeamDeleteInput) => runTeamDelete(deps.service, params),
  }
}
