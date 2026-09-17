import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Where this install keeps agent state.
 *
 * Live Rubato stores it under `~/.rubato-pi/agent`. Older layouts still exist
 * on disk (`~/.rubato/agent`, flat `~/.rubato`, `~/.senpi/agent`), so the
 * location is resolved rather than assumed. Environment always wins.
 */

export const AGENT_DIR_ENV_NAMES = [
  "RUBATO_PI_CODING_AGENT_DIR",
  "RUBATO_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
] as const

/** Marker proving a directory really holds engine state rather than sharing its name. */
export const AGENT_HOME_SENTINEL = "settings.json"

export type AgentHomeEnv = Readonly<Record<string, string | undefined>>

export interface ResolveAgentHomeOptions {
  readonly env: AgentHomeEnv
  readonly homeDir?: string
  readonly exists?: (path: string) => boolean
}

export function resolveAgentHome(options: ResolveAgentHomeOptions): string {
  const { env, homeDir = homedir(), exists = existsSync } = options

  for (const name of AGENT_DIR_ENV_NAMES) {
    const configured = env[name]?.trim()
    if (configured) return resolve(configured)
  }

  const live = join(homeDir, ".rubato-pi", "agent")
  if (exists(join(live, AGENT_HOME_SENTINEL))) return live

  const brandedHome = join(homeDir, ".rubato")
  const canonical = join(brandedHome, "agent")
  if (exists(join(canonical, AGENT_HOME_SENTINEL))) return canonical
  if (exists(join(brandedHome, AGENT_HOME_SENTINEL))) return brandedHome

  const legacySenpi = join(homeDir, ".senpi", "agent")
  if (exists(join(legacySenpi, AGENT_HOME_SENTINEL))) return legacySenpi

  return live
}
