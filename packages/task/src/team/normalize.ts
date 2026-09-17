import { normalizeTeamSpecInput } from "@rubato/team-core/team-registry"
import { TeamSpecSchema, type TeamSpec } from "@rubato/team-core/types"
import { isPlainRecord } from "@rubato/utils"

import { clampTaskSummary } from "../task-summary"
import { SenpiTeamSpecError } from "./errors"

/**
 * Reserved identity for the current senpi session acting as the team lead. It is never a member.
 */
export const TEAM_LEAD_SENTINEL = "lead"

function coerceStringSpec(rawSpec: unknown, teamName: string): unknown {
  if (typeof rawSpec !== "string") return rawSpec
  try {
    return JSON.parse(rawSpec)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new SenpiTeamSpecError(
      `Team '${teamName}' spec is a string that is not valid JSON (${detail}). Pass the spec as an object like { name?, members: [{ name, kind: 'owner'|'verifier', model, effort?, prompt }] }, or as a valid JSON string of that object.`,
      "INVALID_SPEC",
      teamName,
    )
  }
}

function wrapSingleMember(rawSpec: unknown): unknown {
  if (isPlainRecord(rawSpec) && isPlainRecord(rawSpec.members)) {
    return { ...rawSpec, members: [rawSpec.members] }
  }
  return rawSpec
}

function describeReceived(rawSpec: unknown): string {
  if (rawSpec === null) return "null"
  if (Array.isArray(rawSpec)) return "an array"
  if (typeof rawSpec === "object") return "an object"
  return `a ${typeof rawSpec}`
}

function assertNoRawLeadField(rawSpec: unknown, teamName: string): void {
  if (isPlainRecord(rawSpec) && rawSpec.lead !== undefined && rawSpec.lead !== null) {
    throw new SenpiTeamSpecError(
      `Team '${teamName}' declares a 'lead' field. '${TEAM_LEAD_SENTINEL}' is reserved for the current-session sentinel; declare workers under 'members' only.`,
      "RESERVED_LEAD_FIELD",
      teamName,
    )
  }
}

// Harness-side length enforcement mirroring the task tool: an over-limit member task_summary is
// clamped BEFORE TeamSpecSchema.parse so it truncates instead of rejecting the whole spec.
function clampMemberTaskSummaries(members: readonly unknown[]): unknown[] {
  return members.map((member) => {
    if (!isPlainRecord(member) || typeof member.task_summary !== "string") return member
    const clamped = clampTaskSummary(member.task_summary)
    if (clamped === undefined) {
      const { task_summary: _dropped, ...rest } = member
      return rest
    }
    return { ...member, task_summary: clamped }
  })
}

function assertNoReservedMemberName(members: readonly unknown[], teamName: string): void {
  for (const member of members) {
    if (isPlainRecord(member) && member.name === TEAM_LEAD_SENTINEL) {
      throw new SenpiTeamSpecError(
        `Team '${teamName}' has a member named '${TEAM_LEAD_SENTINEL}', which is reserved for the current-session sentinel. Rename the member.`,
        "RESERVED_LEAD_MEMBER",
        teamName,
      )
    }
  }
}

/**
 * Normalizes a raw senpi team spec (from an `rubato.json` `teams` value or an `.rubato/teams/<name>`
 * `config.json`) into a parsed team-core `TeamSpec`.
 *
 * Pipeline: reject reserved lead declarations, run team-core `normalizeTeamSpecInput`, inject the
 * record key as `name`, then parse with `TeamSpecSchema`.
 */
export function normalizeSenpiTeamSpec(
  rawSpec: unknown,
  teamName: string,
): TeamSpec {
  const coerced = wrapSingleMember(coerceStringSpec(rawSpec, teamName))
  assertNoRawLeadField(coerced, teamName)

  const normalized = normalizeTeamSpecInput(coerced)
  if (!isPlainRecord(normalized)) {
    throw new SenpiTeamSpecError(
      `Team '${teamName}' spec must be an object like { name?, members: [...] }; received ${describeReceived(rawSpec)}. Pass the spec as a nested object, or as a valid JSON string of that object.`,
      "INVALID_SPEC",
      teamName,
    )
  }

  const preNormalized: Record<string, unknown> = { ...normalized }
  if (Array.isArray(preNormalized.members)) {
    const members = clampMemberTaskSummaries(preNormalized.members)
    assertNoReservedMemberName(members, teamName)
    preNormalized.members = members
  }
  preNormalized.name ??= teamName
  const parsed = TeamSpecSchema.safeParse(preNormalized)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const detail = firstIssue ? `${firstIssue.path.join(".") || "spec"}: ${firstIssue.message}` : parsed.error.message
    throw new SenpiTeamSpecError(`Invalid team '${teamName}' spec (${detail}).`, "INVALID_SPEC", teamName)
  }

  return parsed.data
}
