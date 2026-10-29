// Storage layout constants and path builders for memory identities.
// Layout decision (plan todo 3): <memory-root>/agents/<safe-id>/{repo,runtime/...}
// where memory-root = RUBATO_MEMORY_HOME override else ~/.rubato/memory.

import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const MEMORY_ROOT_ENV_VAR = "RUBATO_MEMORY_HOME"
export const AGENTS_DIRNAME = "agents"
export const REPO_DIRNAME = "repo"
export const RUNTIME_DIRNAME = "runtime"
/** Self store: the resident soul.md every session loads at start (and a legacy user.md, read only to carry it over). */
export const SELF_DIRNAME = "self"
/**
 * The shared user store: durable facts and preferences about the person, searchable from every
 * project and never loaded whole into a prompt. It sits beside the project stores so search and
 * locking treat it like one, under a name no folder can resolve to: every store a folder resolves to
 * is made of [a-z0-9-] (resolve.ts, msearch_scope.py), and this one holds a dot.
 */
export const USER_STORE_ID = "user.shared"

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

/** `<memory-root>/agents/user.shared/{repo,runtime}`. */
export function userStorePaths(memoryRoot: string): MemoryIdentityPaths {
  return buildIdentityPaths(memoryRoot, USER_STORE_ID)
}

/** The shared user store is not a project's store: listings of projects leave it out. */
export function isUserStore(id: string): boolean {
  return id === USER_STORE_ID
}
