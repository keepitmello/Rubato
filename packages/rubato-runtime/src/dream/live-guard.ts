import { readFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"

import { MEMORY_ROOT_ENV_VAR } from "@rubato/memory-core"

// The dream edits memory with whatever code started it. A session from a scratch clone, a worktree or
// an isolated test profile publishes its own copy's dream CLI, and without a memory root of its own it
// would dream against the user's live memory with test code (seen 2026-10-03: a verifier's /tmp copy
// logged into ~/.rubato/memory/dream-due.log). So the default memory root belongs to the installed
// Rubato only: the copy `~/.local/bin/rubato` runs (install.sh writes that wrapper), on the default
// profile. Any other copy or profile dreams only against a root named in RUBATO_MEMORY_HOME that is
// not the default one; naming the default root explicitly does not count as isolation.

export const RUBATO_WRAPPER = join(".local", "bin", "rubato")
const WRAPPER_TARGET = /exec \/bin\/sh "(.+)\/harness\/scripts\/rubato-pi\.sh"/

export type LiveMemoryVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

/** Repository root of the dream CLI at `cliPath` (packages/rubato-runtime/src/dream/cli.ts). */
export function codeRootOf(cliPath: string): string {
  return resolve(cliPath, "..", "..", "..", "..", "..")
}

/** The Rubato checkout `~/.local/bin/rubato` runs, or undefined when there is no such wrapper. */
export function installedRoot(home: string): string | undefined {
  try {
    const target = WRAPPER_TARGET.exec(readFileSync(join(home, RUBATO_WRAPPER), "utf8"))?.[1]
    return target === undefined ? undefined : real(target)
  } catch {
    return undefined
  }
}

/** May the dream CLI at `cliPath` run against the memory root `env` resolves to? */
export function liveMemoryVerdict(options: {
  readonly env: Record<string, string | undefined>
  readonly home: string
  readonly cliPath: string
}): LiveMemoryVerdict {
  const { env, home } = options
  const override = env[MEMORY_ROOT_ENV_VAR]
  if (override !== undefined && override.trim() !== "" && real(resolve(home, override)) !== real(join(home, ".rubato", "memory"))) return { allowed: true }
  const profile = env.RUBATO_PI_CODING_AGENT_DIR
  if (profile !== undefined && profile.trim() !== "" && real(profile) !== real(join(home, ".rubato-pi", "agent"))) {
    return { allowed: false, reason: `profile ${profile} is not the default one; set ${MEMORY_ROOT_ENV_VAR} to a memory root other than ~/.rubato/memory` }
  }
  const installed = installedRoot(home)
  const code = real(codeRootOf(options.cliPath))
  if (installed === undefined) {
    return { allowed: false, reason: `no installed Rubato at ~/${RUBATO_WRAPPER}; set ${MEMORY_ROOT_ENV_VAR} to a memory root other than ~/.rubato/memory to dream from ${code}` }
  }
  if (installed !== code) {
    return { allowed: false, reason: `${code} is not the installed Rubato (${installed}); set ${MEMORY_ROOT_ENV_VAR} to a memory root other than ~/.rubato/memory to dream from this copy` }
  }
  return { allowed: true }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
