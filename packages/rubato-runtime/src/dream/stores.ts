import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { resolveProjectStore, type MemoryIdentityPaths } from "@rubato/memory-core"

import { readSessionHeader } from "./transcript"

// A store is the memory of the folders that resolve to it: by `memory.agent`, by the git project
// root, or the home directory (resolveProjectStore holds the one rule). Other folders have no store.

export interface SessionFile {
  readonly id: string
  readonly path: string
  readonly cwd: string
  readonly mtimeMs: number
}

export interface StoreSessions {
  readonly store: string
  readonly paths: MemoryIdentityPaths
  readonly sessions: readonly SessionFile[]
}

export type StoreNameResolver = (cwd: string) => string | undefined

/** Store name a session folder writes to, or undefined when it has none (or no longer exists). */
export function createStoreNameResolver(
  readAgent: (cwd: string) => string | undefined,
  env: Record<string, string | undefined> = process.env,
): StoreNameResolver {
  const cache = new Map<string, string | undefined>()
  return (cwd) => {
    if (cache.has(cwd)) return cache.get(cwd)
    const name = existsSync(cwd) ? resolveProjectStore(readAgent(cwd), cwd, { env })?.id : undefined
    cache.set(cwd, name)
    return name
  }
}

export interface StoreScan {
  /** Session files touched after the session's read cursor. */
  readonly sessions: Map<string, SessionFile[]>
  /** Every folder any session of the store ever ran in: where the dream checks claims against code. */
  readonly folders: Map<string, Set<string>>
}

/** Groups session files by the store their folder writes to. */
export function scanStoreSessions(options: {
  readonly sessionsRoot: string
  readonly sinceMs: (store: string, sessionId: string) => number
  readonly resolveStore: StoreNameResolver
}): StoreScan {
  const sessions = new Map<string, SessionFile[]>()
  const folders = new Map<string, Set<string>>()
  for (const path of sessionFiles(options.sessionsRoot)) {
    const header = readSessionHeader(path)
    if (header === undefined) continue
    const store = options.resolveStore(header.cwd)
    if (store === undefined) continue
    const known = folders.get(store) ?? new Set<string>()
    known.add(header.cwd)
    folders.set(store, known)
    const mtimeMs = statSync(path).mtimeMs
    if (mtimeMs <= options.sinceMs(store, header.id)) continue
    const list = sessions.get(store) ?? []
    list.push({ id: header.id, path, cwd: header.cwd, mtimeMs })
    sessions.set(store, list)
  }
  return { sessions, folders }
}

// The engine keeps sessions in two shapes: flat in the root (GUI sessions) and under a folder named
// after the cwd (terminal sessions). Both carry the cwd in their header, which is what decides the store.
function sessionFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (entry.endsWith(".jsonl")) {
      files.push(full)
      continue
    }
    if (!safeIsDirectory(full)) continue
    for (const nested of readdirSync(full)) {
      if (nested.endsWith(".jsonl")) files.push(join(full, nested))
    }
  }
  return files
}

/** Stores that already exist on disk. */
export function listExistingStores(memoryRoot: string): string[] {
  const agents = join(memoryRoot, "agents")
  if (!existsSync(agents)) return []
  return readdirSync(agents)
    .filter((name) => existsSync(join(agents, name, "repo", ".git")))
    .sort()
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Markdown files the store holds (the GUI shows it next to each store). */
export function countStoreFiles(repo: string): number {
  let count = 0
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.isFile() && entry.name.endsWith(".md")) count += 1
    }
  }
  walk(repo)
  return count
}
