import { readFile } from "node:fs/promises"

import { ZodError } from "zod"

import type { TeamModeConfig } from "../config"
import { log } from "../logger"
import { TeamSpecSchema } from "../types"

import type { TeamSpec } from "../types"
import { normalizeTeamSpecInput } from "./team-spec-input-normalizer"
import { discoverTeamSpecs, getTeamSpecPath, resolveBaseDir } from "./paths"
import { TeamSpecValidationError, validateSpec } from "./validator"

type DiscoveredTeamSpec = Awaited<ReturnType<typeof discoverTeamSpecs>>[number]
type JsonRecord = Record<string, unknown>

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function createSpecialCaseValidationError(rawSpec: unknown): TeamSpecValidationError | undefined {
  if (!isJsonRecord(rawSpec)) {
    return undefined
  }

  const rawMembers = rawSpec.members
  if (!Array.isArray(rawMembers)) {
    return undefined
  }

  if (rawMembers.length > 8) {
    const teamName = typeof rawSpec.name === "string" ? rawSpec.name : "<unknown>"
    return new TeamSpecValidationError(
      `Team '${teamName}' exceeds max 8 members.`,
      "TEAM_MEMBER_LIMIT_EXCEEDED",
      "members",
    )
  }

  return undefined
}

function createZodValidationError(rawSpec: unknown, error: ZodError): TeamSpecValidationError {
  const specialCaseError = createSpecialCaseValidationError(rawSpec)
  if (specialCaseError) {
    return specialCaseError
  }

  const firstIssue = error.issues[0]
  const field = firstIssue?.path.join(".") || undefined
  const message = field
    ? `Invalid team spec field '${field}': ${firstIssue.message}`
    : `Invalid team spec: ${error.message}`

  return new TeamSpecValidationError(message, "INVALID_TEAM_SPEC", field)
}

async function loadTeamSpecFromEntry(
  entry: DiscoveredTeamSpec,
): Promise<TeamSpec> {
  let rawText: string
  try {
    rawText = await readFile(entry.path, "utf8")
  } catch (error) {
    const normalizedError = normalizeError(error)
    throw new TeamSpecValidationError(
      `Failed to read team spec '${entry.name}': ${normalizedError.message}`,
      "TEAM_SPEC_READ_FAILED",
    )
  }

  let rawSpec: unknown
  try {
    rawSpec = JSON.parse(rawText)
  } catch (error) {
    const normalizedError = normalizeError(error)
    throw new TeamSpecValidationError(
      `Failed to parse team spec '${entry.name}' JSON: ${normalizedError.message}`,
      "INVALID_JSON",
    )
  }

  const normalizedRawSpec = normalizeTeamSpecInput(rawSpec)
  const parsedSpec = TeamSpecSchema.safeParse(normalizedRawSpec)
  if (!parsedSpec.success) {
    throw createZodValidationError(normalizedRawSpec, parsedSpec.error)
  }

  validateSpec(parsedSpec.data)
  return parsedSpec.data
}

export { TeamSpecValidationError } from "./validator"
export { normalizeTeamSpecInput } from "./team-spec-input-normalizer"

export async function loadTeamSpec(
  teamName: string,
  config: TeamModeConfig,
  projectRoot: string,
): Promise<TeamSpec> {
  const discoveredTeamSpecs = await discoverTeamSpecs(config, projectRoot)
  const matchedTeamSpec = discoveredTeamSpecs.find((entry) => entry.name === teamName)

  if (!matchedTeamSpec) {
    const baseDir = resolveBaseDir(config)
    const projectSpecPath = getTeamSpecPath(baseDir, teamName, "project", projectRoot)
    const userSpecPath = getTeamSpecPath(baseDir, teamName, "user")
    throw new TeamSpecValidationError(
      `Team '${teamName}' was not found. Expected '${projectSpecPath}' or '${userSpecPath}'.`,
      "TEAM_SPEC_NOT_FOUND",
      "name",
    )
  }

  return loadTeamSpecFromEntry(matchedTeamSpec)
}

export async function loadAllTeamSpecs(
  config: TeamModeConfig,
  projectRoot: string,
): Promise<Array<{ name: string; scope: "project" | "user"; spec?: TeamSpec; error?: Error }>> {
  const discoveredTeamSpecs = await discoverTeamSpecs(config, projectRoot)

  return Promise.all(discoveredTeamSpecs.map(async (entry) => {
    try {
      const spec = await loadTeamSpecFromEntry(entry)
      return { name: entry.name, scope: entry.scope, spec }
    } catch (error) {
      const normalizedError = normalizeError(error)
      log("team-spec load failed", {
        event: "team-spec-load-failed",
        teamName: entry.name,
        scope: entry.scope,
        path: entry.path,
        error: normalizedError.message,
      })
      return { name: entry.name, scope: entry.scope, error: normalizedError }
    }
  }))
}
