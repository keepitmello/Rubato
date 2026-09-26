// Storage layout constants and path builders for memory identities.
// Layout decision (plan todo 3): <memory-root>/agents/<safe-id>/{repo,runtime/...}
// where memory-root = RUBATO_MEMORY_HOME override else ~/.rubato/memory.

import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const MEMORY_ROOT_ENV_VAR = "RUBATO_MEMORY_HOME"
export const AGENTS_DIRNAME = "agents"
export const REPO_DIRNAME = "repo"
export const RUNTIME_DIRNAME = "runtime"
/** Self store: the resident user.md/soul.md every session loads at start. */
export const SELF_DIRNAME = "self"

export interface MemoryIdentityPaths {
  root: string
  repo: string
  runtime: string
  locks: string
  /** Where the dream checks out the branch it edits. */
  worktrees: string
}

export function defaultMemoryRoot(): string {
  return join(homedir(), ".rubato", "memory")
}

export function resolveMemoryRoot(env: Record<string, string | undefined>, cwd: string): string {
  const override = env[MEMORY_ROOT_ENV_VAR]
  if (override === undefined || override.trim() === "") {
    return defaultMemoryRoot()
  }
  return resolve(cwd, override)
}

export function buildIdentityPaths(memoryRoot: string, id: string): MemoryIdentityPaths {
  const root = join(memoryRoot, AGENTS_DIRNAME, id)
  const runtime = join(root, RUNTIME_DIRNAME)
  return {
    root,
    repo: join(root, REPO_DIRNAME),
    runtime,
    locks: join(runtime, "locks"),
    worktrees: join(runtime, "worktrees"),
  }
}

/** Repository holding the resident files: `<memory-root>/self/repo`. */
export function selfRepoPath(memoryRoot: string): string {
  return join(memoryRoot, SELF_DIRNAME, REPO_DIRNAME)
}
