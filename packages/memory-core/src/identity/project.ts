// Which memory store a folder writes to. One rule, kept identical in three places: this module
// (engine memory component and dream CLI) and msearch's `msearch_scope.py`.
//
//   1. `memory.agent` set in the folder's config (not empty, not "auto"): that name.
//   2. Inside a git work tree: the store whose store.json `roots` holds the repository root;
//      else the root's basename as a slug, with a short hash of the root when a store of that
//      name already belongs to other roots.
//   3. The home directory itself: the store `home`.
//   4. Anywhere else: no store.
//
// Resolution never creates anything. The store directory appears on the first memory write, and
// store.json records each root a session bound from.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

import { AGENTS_DIRNAME, buildIdentityPaths, resolveMemoryRoot } from "./layout"
import { isAutoAgentValue, resolveMemoryIdentity, sanitizeToSlug, shortHash, type MemoryIdentity } from "./resolve"

export const STORE_FILE = "store.json"
export const HOME_STORE = "home"

/** `<store>/store.json`: machine-local, outside the repository. */
export interface StoreRecord {
  readonly roots: readonly string[]
  readonly home?: boolean
}

export interface ProjectStore extends MemoryIdentity {
  /** The project root this folder belongs to, when it is in a git work tree. */
  readonly root?: string
  /** True for the home-directory store. */
  readonly home: boolean
}

export interface ResolveProjectStoreOptions {
  readonly env?: Record<string, string | undefined>
  /** Repository root of a folder; defaults to `git rev-parse --show-toplevel`. */
  readonly gitRoot?: (cwd: string) => string | undefined
  readonly homeDir?: string
}

export function resolveProjectStore(
  configAgentValue: string | null | undefined,
  cwd: string,
  options: ResolveProjectStoreOptions = {},
): ProjectStore | undefined {
  const env = options.env ?? process.env
  const memoryRoot = resolveMemoryRoot(env, cwd)
  const root = (options.gitRoot ?? gitProjectRoot)(cwd)
  if (!isAutoAgentValue(configAgentValue)) {
    const named = resolveMemoryIdentity(configAgentValue, cwd, env)
    return named === undefined ? undefined : { ...named, ...(root === undefined ? {} : { root }), home: false }
  }
  if (root !== undefined) {
    const id = storeForRoot(memoryRoot, root)
    return { id, safeSlug: sanitizeToSlug(basename(root)), paths: buildIdentityPaths(memoryRoot, id), root, home: false }
  }
  const home = canonical(options.homeDir ?? env.HOME ?? homedir())
  if (canonical(cwd) === home) {
    return { id: HOME_STORE, safeSlug: HOME_STORE, paths: buildIdentityPaths(memoryRoot, HOME_STORE), home: true }
  }
  return undefined
}

function storeForRoot(memoryRoot: string, root: string): string {
  const agents = join(memoryRoot, AGENTS_DIRNAME)
  for (const store of listStoreDirs(agents)) {
    if (readStoreRecord(join(agents, store))?.roots.includes(root) === true) return store
  }
  const name = sanitizeToSlug(basename(root))
  const taken = readStoreRecord(join(agents, name))
  const belongsElsewhere = taken !== undefined && (taken.home === true || taken.roots.length > 0)
  return belongsElsewhere ? `${name}-${shortHash(root)}` : name
}

/** Repository root of `cwd`, or undefined outside a git work tree (or without git). */
export function gitProjectRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    }).trim()
    return out === "" ? undefined : canonical(out)
  } catch {
    return undefined
  }
}

export function readStoreRecord(storeDir: string): StoreRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(storeDir, STORE_FILE), "utf8"))
    if (value === null || typeof value !== "object") return undefined
    const roots = Reflect.get(value, "roots")
    const home = Reflect.get(value, "home") === true
    return {
      roots: Array.isArray(roots) ? roots.filter((item): item is string => typeof item === "string") : [],
      ...(home ? { home } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Adds this store's root (or its home flag) to store.json. Writes only when something is new, and
 * only into a store directory that already exists unless `create` is set (the first memory write).
 */
export function recordStoreRoot(
  store: { readonly paths: { readonly root: string }; readonly root?: string; readonly home: boolean },
  options: { readonly create?: boolean } = {},
): void {
  const dir = store.paths.root
  if (!existsSync(dir) && options.create !== true) return
  const current = readStoreRecord(dir) ?? { roots: [] }
  const roots = store.root === undefined || current.roots.includes(store.root) ? current.roots : [...current.roots, store.root]
  const home = current.home === true || store.home
  if (roots === current.roots && home === (current.home === true) && existsSync(join(dir, STORE_FILE))) return
  mkdirSync(dir, { recursive: true })
  const next: StoreRecord = { roots, ...(home ? { home: true } : {}) }
  const temp = join(dir, `${STORE_FILE}.${process.pid}.tmp`)
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  renameSync(temp, join(dir, STORE_FILE))
}

function listStoreDirs(agents: string): string[] {
  try {
    return readdirSync(agents, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}
