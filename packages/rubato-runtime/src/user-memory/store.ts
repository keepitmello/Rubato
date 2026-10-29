// The shared user store's places. The store itself is <memory-root>/agents/user.shared/repo, a git
// repository like a project store, so search, locks and worktrees are the same; beside it, in runtime/
// (never indexed, never committed), the things that are not memory:
//
//   runtime/forgotten.json        what the user asked to forget: blocks it from coming back
//   runtime/summary.json          the display summary, one line per record blob, in the user's language
//   runtime/asks/<id>/            one request from Settings > Memory: request.json in, result.json out
//   runtime/observations/<run>.json  observations a user dream consumed: evidence an explanation can cite
//   runtime/dream/                the user dream's runs and its input ledger

import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"

import { GitMemoryRepo, USER_STORE_ID, userStorePaths, type MemoryIdentityPaths } from "@rubato/memory-core"

export interface UserStore {
  readonly id: typeof USER_STORE_ID
  readonly paths: MemoryIdentityPaths
  readonly ledger: string
  readonly summary: string
  readonly asks: string
  readonly observations: string
  readonly inputs: string
}

export function userStore(memoryRoot: string): UserStore {
  const paths = userStorePaths(memoryRoot)
  return {
    id: USER_STORE_ID,
    paths,
    ledger: join(paths.runtime, "forgotten.json"),
    summary: join(paths.runtime, "summary.json"),
    asks: join(paths.runtime, "asks"),
    observations: join(paths.runtime, "observations"),
    inputs: join(paths.runtime, "dream", "inputs.json"),
  }
}

/** Creates the store (one empty commit) when it is missing. Nothing else is written. */
export async function ensureUserStore(store: UserStore): Promise<void> {
  if (existsSync(join(store.paths.repo, ".git"))) return
  await new GitMemoryRepo({ dir: store.paths.repo, agentId: store.id }).init({ authorName: "Rubato" })
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return parsed !== null && typeof parsed === "object" ? parsed as T : undefined
  } catch {
    return undefined
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}
