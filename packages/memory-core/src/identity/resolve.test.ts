import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AGENTS_DIRNAME, MEMORY_ROOT_ENV_VAR } from "./layout"
import { resolveMemoryIdentity } from "./resolve"

function expectedHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 8)
}

describe("resolveMemoryIdentity unnamed folders", () => {
  it("#given memory.agent unset, blank, or auto #when resolved #then the folder has no store", () => {
    // given / when / then
    for (const value of [undefined, null, "", "   ", "auto"]) {
      expect(resolveMemoryIdentity(value, "/repo/alpha", {})).toBeUndefined()
    }
  })
})

describe("resolveMemoryIdentity explicit mode", () => {
  it("#given a slug-safe explicit id 'backend-lead' #when resolved #then the dir is agents/backend-lead with no hash suffix", () => {
    // given / when
    const identity = resolveMemoryIdentity("backend-lead", "/repo/alpha", {})
    // then
    expect(identity!.safeSlug).toBe("backend-lead")
    expect(identity!.id).toBe("backend-lead")
    expect(identity!.paths.root).toBe(
      join(homedir(), ".rubato", "memory", AGENTS_DIRNAME, "backend-lead"),
    )
  })

  it("#given an explicit id that is not slug-safe #when resolved #then the hash suffix disambiguates it", () => {
    // given / when
    const identity = resolveMemoryIdentity("Backend Lead", "/repo/alpha", {})
    // then
    const expectedId = `backend-lead-${expectedHash("Backend Lead")}`
    expect(identity!.safeSlug).toBe("backend-lead")
    expect(identity!.id).toBe(expectedId)
    expect(identity!.id).not.toBe("backend-lead")
  })

  it("#given an explicit id with surrounding whitespace #when resolved #then it matches the trimmed form", () => {
    // given / when
    const padded = resolveMemoryIdentity("  backend-lead  ", "/repo/alpha", {})
    const plain = resolveMemoryIdentity("backend-lead", "/repo/alpha", {})
    // then
    expect(padded!.id).toBe(plain!.id)
  })

  it("#given 'Auto' #when resolved #then only the lowercase keyword means unnamed", () => {
    // given / when
    const named = resolveMemoryIdentity("Auto", "/repo/alpha", {})
    // then
    expect(named?.safeSlug).toBe("auto")
    expect(named?.id).toBe(`auto-${expectedHash("Auto")}`)
  })
})

describe("resolveMemoryIdentity root override", () => {
  it("#given RUBATO_MEMORY_HOME #when resolved #then paths honor it and sanitization still applies", () => {
    // given (tmpdir() is absolute on every platform, so "verbatim" holds on Windows too)
    const overrideRoot = join(tmpdir(), "qa-memory-home")
    const env = { [MEMORY_ROOT_ENV_VAR]: overrideRoot }
    // when
    const identity = resolveMemoryIdentity("../evil", "/repo/alpha", env)
    // then
    expect(identity!.paths.root).toBe(
      join(overrideRoot, AGENTS_DIRNAME, `evil-${expectedHash("../evil")}`),
    )
    expect(identity!.paths.repo).toBe(join(identity!.paths.root, "repo"))
    expect(identity!.paths.locks).toBe(join(identity!.paths.root, "runtime", "locks"))
  })

  it("#given a relative RUBATO_MEMORY_HOME #when resolved #then it resolves against the cwd argument", () => {
    // given
    const env = { [MEMORY_ROOT_ENV_VAR]: "qa-home" }
    // when
    const identity = resolveMemoryIdentity("backend-lead", "/work/proj", env)
    // then (Windows qualifies the drive; resolve() is the platform semantics the impl applies)
    expect(identity!.paths.root).toBe(
      join(resolve("/work/proj", "qa-home"), AGENTS_DIRNAME, identity!.id),
    )
  })

  it("#given no env argument #when RUBATO_MEMORY_HOME is set in the process env #then the default env read honors it", () => {
    // given
    const previous = process.env[MEMORY_ROOT_ENV_VAR]
    process.env[MEMORY_ROOT_ENV_VAR] = join(tmpdir(), "qa-process-env-home")
    try {
      // when
      const identity = resolveMemoryIdentity("backend-lead", "/repo/alpha")
      // then
      expect(identity!.paths.root).toBe(
        join(resolve("/repo/alpha", join(tmpdir(), "qa-process-env-home")), AGENTS_DIRNAME, identity!.id),
      )
    } finally {
      if (previous === undefined) {
        delete process.env[MEMORY_ROOT_ENV_VAR]
      } else {
        process.env[MEMORY_ROOT_ENV_VAR] = previous
      }
    }
  })
})

describe("resolveMemoryIdentity input guards", () => {
  it("#given an empty cwd #when resolved #then it throws a TypeError", () => {
    // given / when / then
    expect(() => resolveMemoryIdentity("backend-lead", "", {})).toThrow(TypeError)
    expect(() => resolveMemoryIdentity("backend-lead", "   ", {})).toThrow(TypeError)
  })
})
