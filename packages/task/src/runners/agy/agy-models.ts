import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const AGY_PROVIDER_ID = "agy"

/** Gemini models exposed to Rubato's Agent tool through the user's official `agy` CLI. */
export const AGY_AGENT_MODELS = Object.freeze([
  `${AGY_PROVIDER_ID}/gemini-4-neon`,
  `${AGY_PROVIDER_ID}/gemini-4-hydrogen`,
  `${AGY_PROVIDER_ID}/gemini-4-argon`,
] as const)

const AGY_MODEL_SET = new Set<string>(AGY_AGENT_MODELS)

export function isAgyAgentModel(model: string | undefined): model is string {
  return typeof model === "string" && AGY_MODEL_SET.has(model.trim().toLowerCase())
}

export function agyModelSlug(model: string): string {
  const normalized = model.trim().toLowerCase()
  return normalized.startsWith(`${AGY_PROVIDER_ID}/`)
    ? normalized.slice(AGY_PROVIDER_ID.length + 1)
    : normalized
}

export function resolveAgyUserHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return env.HOME || (platform === "win32" ? env.USERPROFILE : undefined) || homedir()
}

/**
 * Locate the official `agy` binary on PATH or under `~/.local/bin` (Windows: `agy.exe`).
 * Returns an absolute path, or undefined when `agy` is not installed.
 */
export function findLocalAgySync(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const override = env.RUBATO_AGY_BINARY?.trim()
  if (override) {
    const isAbs = platform === "win32" ? path.win32.isAbsolute(override) : path.posix.isAbsolute(override)
    if (isAbs) {
      try {
        accessSync(override, platform === "win32" ? constants.F_OK : constants.X_OK)
        return override
      } catch {
        return undefined
      }
    }
    return undefined
  }

  const windows = platform === "win32"
  const pathValue = windows
    ? Object.entries(env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
    : env.PATH
  const isAbs = windows ? path.win32.isAbsolute : path.posix.isAbsolute
  const directories = (pathValue ?? "").split(windows ? ";" : ":").filter((entry) => isAbs(entry))
  const home = env.HOME || (windows ? env.USERPROFILE : undefined)
  if (home) directories.push(path.join(home, ".local", "bin"))

  const binaryName = windows ? "agy.exe" : "agy"
  const mode = windows ? constants.F_OK : constants.X_OK
  for (const directory of directories) {
    const candidate = path.join(directory, binaryName)
    try {
      accessSync(candidate, mode)
      return candidate
    } catch {
      // try next directory
    }
  }
  return undefined
}

/** Returns `agy/*` Agent models only when the official `agy` binary is installed locally. */
export function availableAgyAgentModels(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return findLocalAgySync(env, platform) !== undefined ? AGY_AGENT_MODELS : []
}

const MINIMAL_ENV_KEYS = new Set([
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "PATHEXT",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMDATA",
])

/** Build a clean environment for `agy` without leaking Rubato secrets or endpoint overrides. */
export function minimalAgyEnv(env: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const clean: Record<string, string> = { HOME: home }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && MINIMAL_ENV_KEYS.has(key.toUpperCase()) && key.toUpperCase() !== "HOME") {
      clean[key] = value
    }
  }
  return clean
}
