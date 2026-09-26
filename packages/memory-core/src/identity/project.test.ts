import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { STORE_FILE, readStoreRecord, recordStoreRoot, resolveProjectStore, shortHash } from "./index"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sandbox() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rubato-store-rule-")))
  roots.push(root)
  const home = join(root, "home")
  mkdirSync(home)
  const env = { RUBATO_MEMORY_HOME: join(root, "memory"), HOME: home }
  return { root, home, env }
}

function gitRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: path })
  return realpathSync.native(path)
}

describe("resolveProjectStore", () => {
  it("#given a subfolder of a git repository #when resolved #then the store is named after the repository root", () => {
    const { root, env } = sandbox()
    const repo = gitRepo(join(root, "work", "Hash-Game"))
    mkdirSync(join(repo, "src", "deep"), { recursive: true })

    const store = resolveProjectStore(undefined, join(repo, "src", "deep"), { env })

    expect(store?.id).toBe("hash-game")
    expect(store?.root).toBe(repo)
    expect(existsSync(join(env.RUBATO_MEMORY_HOME, "agents"))).toBe(false)
  })

  it("#given two repositories with the same basename #when the first already has its store #then the second gets a distinct name", () => {
    const { root, env } = sandbox()
    const first = gitRepo(join(root, "a", "app"))
    const second = gitRepo(join(root, "b", "app"))

    const firstStore = resolveProjectStore("auto", first, { env })
    if (firstStore === undefined) throw new Error("expected a store")
    recordStoreRoot(firstStore, { create: true })
    const secondStore = resolveProjectStore("auto", second, { env })

    expect(firstStore.id).toBe("app")
    expect(secondStore?.id).toBe(`app-${shortHash(second)}`)
    expect(resolveProjectStore(undefined, first, { env })?.id).toBe("app")
  })

  it("#given a store whose store.json lists the root #when resolved #then that store wins over the basename", () => {
    const { root, env } = sandbox()
    const repo = gitRepo(join(root, "renamed-checkout"))
    const shared = resolveProjectStore("shared", repo, { env })
    if (shared === undefined) throw new Error("expected a store")
    recordStoreRoot(shared, { create: true })

    expect(resolveProjectStore(undefined, repo, { env })?.id).toBe("shared")
  })

  it("#given the home directory itself #when resolved #then the store is home, and a folder below it is not", () => {
    const { home, env } = sandbox()
    mkdirSync(join(home, "Downloads"))

    expect(resolveProjectStore(undefined, home, { env })).toMatchObject({ id: "home", home: true })
    expect(resolveProjectStore(undefined, join(home, "Downloads"), { env })).toBeUndefined()
  })

  it("#given a folder outside git and outside home #when resolved #then there is no store", () => {
    const { root, env } = sandbox()
    const plain = join(root, "scratch")
    mkdirSync(plain)

    expect(resolveProjectStore(undefined, plain, { env })).toBeUndefined()
  })

  it("#given memory.agent in the folder's config #when resolved #then the name wins over the repository", () => {
    const { root, env } = sandbox()
    const repo = gitRepo(join(root, "rubato-lab"))

    const store = resolveProjectStore("rubato", repo, { env })

    expect(store?.id).toBe("rubato")
    expect(store?.root).toBe(repo)
  })
})

describe("recordStoreRoot", () => {
  it("#given a store that does not exist #when a session binds #then nothing is created until the first write", () => {
    const { root, env } = sandbox()
    const repo = gitRepo(join(root, "fresh"))
    const store = resolveProjectStore(undefined, repo, { env })
    if (store === undefined) throw new Error("expected a store")

    recordStoreRoot(store)
    expect(existsSync(store.paths.root)).toBe(false)
    recordStoreRoot(store, { create: true })
    recordStoreRoot(store, { create: true })

    expect(readStoreRecord(store.paths.root)).toEqual({ roots: [repo] })
    expect(JSON.parse(readFileSync(join(store.paths.root, STORE_FILE), "utf8"))).toEqual({ roots: [repo] })
  })
})
