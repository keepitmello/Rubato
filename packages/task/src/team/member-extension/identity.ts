declare const RUBATO_MEMBER_BUNDLE: string | undefined

export const MEMBER_IDENTITY_ENV = "RUBATO_TASK_MEMBER"
export const LEGACY_MEMBER_IDENTITY_ENV = "SENPI_TASK_MEMBER"
export const MEMBER_TASK_ID_ENV = "RUBATO_TASK_MEMBER_TASK_ID"
export const LEGACY_MEMBER_TASK_ID_ENV = "SENPI_TASK_MEMBER_TASK_ID"
export const MEMBER_TEAM_CONFIG_ENV = "RUBATO_TASK_TEAM_CONFIG"
export const LEGACY_MEMBER_TEAM_CONFIG_ENV = "SENPI_TASK_TEAM_CONFIG"
export const MEMBER_PROCESS_ENV_NAMES = [
  MEMBER_IDENTITY_ENV,
  MEMBER_TASK_ID_ENV,
  MEMBER_TEAM_CONFIG_ENV,
  LEGACY_MEMBER_IDENTITY_ENV,
  LEGACY_MEMBER_TASK_ID_ENV,
  LEGACY_MEMBER_TEAM_CONFIG_ENV,
] as const
export const MEMBER_EXTENSION_BUNDLE_NAME =
  typeof RUBATO_MEMBER_BUNDLE !== "undefined" ? RUBATO_MEMBER_BUNDLE : "rubato-member.js"

export function memberIdentityValue(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const next = env[MEMBER_IDENTITY_ENV]
  if (next !== undefined && next.length > 0) return next
  const legacy = env[LEGACY_MEMBER_IDENTITY_ENV]
  if (legacy !== undefined && legacy.length > 0) return legacy
  return undefined
}

export function isTeamMemberProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return memberIdentityValue(env) !== undefined
}
