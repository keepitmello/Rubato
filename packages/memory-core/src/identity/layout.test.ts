import { describe, expect, it } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  AGENTS_DIRNAME,
  buildIdentityPaths,
  defaultMemoryRoot,
  MEMORY_ROOT_ENV_VAR,
  REPO_DIRNAME,
  RUNTIME_DIRNAME,
  resolveMemoryRoot,
} from "./layout"

describe("defaultMemoryRoot", () => {
  it("#given no override #when the default root is computed #then it is ~/.rubato/memory", () => {
    // given / when
    const root = defaultMemoryRoot()
    // then
    expect(root).toBe(join(homedir(), ".rubato", "memory"))
  })
})

describe("resolveMemoryRoot", () => {
  it("#given an absolute RUBATO_MEMORY_HOME #when the root is resolved #then the override is used verbatim", () => {
    // given (tmpdir() is absolute on every platform, so "verbatim" holds on Windows too)
    const overrideRoot = join(tmpdir(), "qa-memory-home")
    const env = { [MEMORY_ROOT_ENV_VAR]: overrideRoot }
    // when
    const root = resolveMemoryRoot(env, "/work/proj")
    // then
    expect(root).toBe(overrideRoot)
  })

  it("#given a relative RUBATO_MEMORY_HOME #when the root is resolved #then it resolves against the given cwd", () => {
    // given
    const env = { [MEMORY_ROOT_ENV_VAR]: "qa-home" }
    // when
    const root = resolveMemoryRoot(env, "/work/proj")
    // then (Windows qualifies the drive; resolve() is the platform semantics the impl applies)
    expect(root).toBe(resolve("/work/proj", "qa-home"))
  })

  it("#given an empty or whitespace RUBATO_MEMORY_HOME #when the root is resolved #then the default root is used", () => {
    // given
    const expected = join(homedir(), ".rubato", "memory")
    // when / then
    expect(resolveMemoryRoot({ [MEMORY_ROOT_ENV_VAR]: "" }, "/work/proj")).toBe(expected)
    expect(resolveMemoryRoot({ [MEMORY_ROOT_ENV_VAR]: "   " }, "/work/proj")).toBe(expected)
    expect(resolveMemoryRoot({}, "/work/proj")).toBe(expected)
  })
})

describe("buildIdentityPaths", () => {
  it("#given a memory root and id #when paths are built #then the decided layout shape is produced", () => {
    // given
    const memoryRoot = "/mem"
    const id = "backend-lead-0123abcd"
    // when
    const paths = buildIdentityPaths(memoryRoot, id)
    // then
    const root = join(memoryRoot, "agents", id)
    const runtime = join(root, "runtime")
    expect(paths.root).toBe(root)
    expect(paths.repo).toBe(join(root, "repo"))
    expect(paths.runtime).toBe(runtime)
    expect(paths.locks).toBe(join(runtime, "locks"))
    expect(paths.worktrees).toBe(join(runtime, "worktrees"))
  })
})
