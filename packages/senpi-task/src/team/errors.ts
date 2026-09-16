export type SenpiTeamSpecErrorCode =
  | "RESERVED_LEAD_FIELD"
  | "RESERVED_LEAD_MEMBER"
  | "INVALID_SPEC"
  | "MODEL_UNAVAILABLE"

/**
 * Raised when a senpi-task team spec cannot be normalized or validated. Carries a typed `code` so
 * callers can distinguish the three reserved-name rejection paths (raw `lead` field, member named
 * a reserved `lead`) from schema and member-vocabulary failures. Every path that
 * throws this error spawns zero members.
 */
export class SenpiTeamSpecError extends Error {
  readonly code: SenpiTeamSpecErrorCode
  readonly teamName: string

  constructor(message: string, code: SenpiTeamSpecErrorCode, teamName: string) {
    super(message)
    this.name = "SenpiTeamSpecError"
    this.code = code
    this.teamName = teamName
  }
}
