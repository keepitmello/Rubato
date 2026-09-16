import type { Member, TeamSpec } from "../types"

const MAX_TEAM_MEMBERS = 8

export class TeamSpecValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly field?: string,
    public readonly memberName?: string,
  ) {
    super(message)
    this.name = "TeamSpecValidationError"
  }
}

export function validateSpec(spec: TeamSpec): void {
  if (spec.members.length > MAX_TEAM_MEMBERS) {
    throw new TeamSpecValidationError(
      `Team '${spec.name}' exceeds max 8 members.`,
      "TEAM_MEMBER_LIMIT_EXCEEDED",
      "members",
    )
  }

  const seenMemberNames = new Set<string>()
  for (const member of spec.members) {
    if (seenMemberNames.has(member.name)) {
      throw new TeamSpecValidationError(
        `Member name '${member.name}' is duplicated within team '${spec.name}'. Member names must be unique.`,
        "DUPLICATE_MEMBER_NAME",
        "members",
        member.name,
      )
    }

    seenMemberNames.add(member.name)
    validateDualSupport(member)

  }
}

export function validateDualSupport(member: Member): void {
  const trimmedPrompt = member.prompt?.trim()

  if (trimmedPrompt === "") {
    throw new TeamSpecValidationError(
      `Member '${member.name}' prompt must not be empty after trimming whitespace.`,
      "EMPTY_PROMPT",
      "prompt",
      member.name,
    )
  }
}
