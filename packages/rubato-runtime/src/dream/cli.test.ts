import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dreamLadder } from "./ladder"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dreamStatus(userConfig: string | undefined, stores: readonly string[] = []): unknown {
  const home = mkdtempSync(join(tmpdir(), "dream-cli-test-"))
  dirs.push(home)
  mkdirSync(join(home, ".rubato", "memory"), { recursive: true })
  for (const store of stores) mkdirSync(join(home, ".rubato", "memory", "agents", store, "repo", ".git"), { recursive: true })
  if (userConfig !== undefined) writeFileSync(join(home, ".rubato", "rubato.jsonc"), userConfig)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    RUBATO_MEMORY_HOME: join(home, ".rubato", "memory"),
    RUBATO_PI_CODING_AGENT_DIR: join(home, "agent"),
  }
  const out = execFileSync(process.execPath, [join(import.meta.dir, "cli.ts"), "--json"], { cwd: home, env, encoding: "utf8" })
  return JSON.parse(out)
}

describe("rubato dream --json status", () => {
  test("#given no dream models in the config #when status is read #then the default ladder is reported as models", () => {
    expect(dreamStatus(undefined)).toEqual({
      models: [
        { model: "b-ai/deepseek-v4.1-flash", thinking: "medium" },
        { model: "xai/grok-4.7", thinking: "medium" },
        { model: "anthropic/claude-haiku-4-5", thinking: "off" },
      ],
      stores: [],
    })
  })

  test("#given memory.dream.models in the user config #when status is read #then that ladder is reported in order", () => {
    const config = JSON.stringify({ memory: { dream: { models: ["xai/grok-4.7", { model: "anthropic/claude-haiku-4-5", reasoning: "off" }] } } })
    expect(dreamStatus(config)).toEqual({
      models: [{ model: "xai/grok-4.7" }, { model: "anthropic/claude-haiku-4-5", thinking: "off" }],
      stores: [],
    })
  })
})

describe("rubato dream store switch", () => {
  test("#given stores the config does not name #when status is read #then they dream; only false turns one off", () => {
    const config = JSON.stringify({ memory: { dream: { stores: { quiet: { enabled: false }, listed: { enabled: true } } } } })
    const status = dreamStatus(config, ["fresh", "listed", "quiet"]) as { stores: { store: string; enabled: boolean }[] }
    expect(Object.fromEntries(status.stores.map((entry) => [entry.store, entry.enabled]))).toEqual({ fresh: true, listed: true, quiet: false })
  })
})

function koreanStore(memory: string, store: string): string {
  const repo = join(memory, "agents", store, "repo")
  mkdirSync(join(repo, "decisions"), { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  writeFileSync(join(repo, "decisions", "cache.md"), "## 결론\n- 접두는 고정한다.\n\n## 증상\n캐시가 깨졌다\n")
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo })
  return repo
}

function dreamDue(env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "--due"], { cwd, env, encoding: "utf8", timeout: 120_000 })
}

const migrationRuns = (memory: string, store: string) => {
  const runs = join(memory, "agents", store, "runtime", "dream", "runs")
  return existsSync(runs) ? readdirSync(runs).filter((name) => name.startsWith("migrate-")) : []
}

describe("rubato dream --due and the live memory root", () => {
  // 2026-10-03: a verifier's scratch copy ran `dream --due` against the live ~/.rubato/memory.
  test("#given this copy is not the installed Rubato and no memory root is named #when --due runs #then it writes nothing under the default root, even when that root is named explicitly", () => {
    const home = mkdtempSync(join(tmpdir(), "dream-cli-test-"))
    dirs.push(home)
    const memory = join(home, ".rubato", "memory")
    koreanStore(memory, "demo")
    for (const env of [{ PATH: process.env.PATH, HOME: home }, { PATH: process.env.PATH, HOME: home, RUBATO_MEMORY_HOME: memory }]) {
      const result = dreamDue(env, home)
      expect(result.status).toBe(0)
      expect(result.stderr).toContain("nothing ran")
    }
    expect(existsSync(join(memory, "agents", "demo", "runtime"))).toBe(false)
  })
})

/**
 * An engine stand-in at RUBATO_PI_ENGINE_DIR: `fake/translator` translates this test's one record,
 * any other model fails. The dream CLI launches it exactly as it launches the real engine.
 */
function fakeEngine(home: string): string {
  const root = join(home, "engine")
  const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
  mkdirSync(join(cli, ".."), { recursive: true })
  mkdirSync(join(root, "rubato-features", "child-runtime"), { recursive: true })
  writeFileSync(join(root, "rubato-features", "child-runtime", "provider-extension.mjs"), "")
  writeFileSync(cli, `
const { readFileSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const model = process.argv[process.argv.indexOf("--model") + 1]
if (model !== "fake/translator") { console.error("no such model: " + model); process.exit(1) }
const batch = JSON.parse(readFileSync(process.env.MIGRATE_BATCH, "utf8"))
for (const file of batch.files) {
  const path = join(process.env.MEMORY_DIR, file)
  writeFileSync(path, readFileSync(path, "utf8").replace("## 결론", "## Conclusion").replace("- 접두는 고정한다.", "- The prefix stays fixed.").replace("## 증상", "## Symptom"))
}
console.log("MIGRATE_DONE " + batch.files.length)
`)
  return root
}

function otherMachine(models: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), "dream-cli-test-"))
  dirs.push(home)
  const memory = join(home, "other-machine-memory")
  koreanStore(memory, "demo")
  koreanStore(memory, "quiet")
  mkdirSync(join(home, ".rubato"), { recursive: true })
  writeFileSync(join(home, ".rubato", "rubato.jsonc"), JSON.stringify({ memory: { dream: { models, stores: { quiet: { enabled: false } } } } }))
  const env = {
    PATH: process.env.PATH, HOME: home, RUBATO_MEMORY_HOME: memory,
    RUBATO_PI_CODING_AGENT_DIR: join(home, "agent"), RUBATO_PI_ENGINE_DIR: fakeEngine(home),
  }
  const record = join(memory, "agents", "demo", "repo", "decisions", "cache.md")
  return { home, memory, env, record }
}

describe("rubato dream --due and the English migration (a simulated other machine)", () => {
  test("#given a store with Korean records and no new sessions #when --due runs #then it migrates once, the disabled store is left alone, and a revert sticks", () => {
    const { home, memory, env, record } = otherMachine(["fake/translator"])

    expect(dreamDue(env, home).status).toBe(0)
    const runs = migrationRuns(memory, "demo")
    expect(runs).toHaveLength(1)
    expect(readFileSync(record, "utf8")).toBe("## Conclusion\n- The prefix stays fixed.\n\n## Symptom\n캐시가 깨졌다\n")
    expect(migrationRuns(memory, "quiet")).toEqual([])

    expect(dreamDue(env, home).status).toBe(0)
    expect(migrationRuns(memory, "demo")).toHaveLength(1)

    const revert = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "--revert", "demo", runs[0]!], { cwd: home, env, encoding: "utf8" })
    expect(revert.status).toBe(0)
    expect(readFileSync(record, "utf8")).toContain("## 증상")
    expect(dreamDue(env, home).status).toBe(0)
    expect(migrationRuns(memory, "demo")).toHaveLength(1)
  }, 180_000)

  test("#given no model can do it #when --due runs #then nothing lands and the next --due waits for the retry gap", () => {
    const { home, memory, env, record } = otherMachine(["nowhere/none"])
    expect(dreamDue(env, home).status).toBe(1)
    const runs = migrationRuns(memory, "demo")
    expect(runs).toHaveLength(1)
    const run = JSON.parse(readFileSync(join(memory, "agents", "demo", "runtime", "dream", "runs", runs[0]!, "run.json"), "utf8"))
    expect(run).toMatchObject({ kind: "language-migration", status: "failed" })
    expect(readFileSync(record, "utf8")).toContain("## 증상")
    expect(dreamDue(env, home).status).toBe(0)
    expect(migrationRuns(memory, "demo")).toHaveLength(1)
  }, 180_000)
})

describe("dreamLadder", () => {
  test("#given bare ids, pairs, repeats and a name without a provider #when laddered #then order holds and only launchable, first-seen rungs stay", () => {
    expect(dreamLadder([
      "b-ai/deepseek-v4.1-flash",
      { model: "xai/grok-4.7", reasoning: "high" },
      "grok",
      { model: "b-ai/deepseek-v4.1-flash", reasoning: "low" },
    ])).toEqual([
      { model: "b-ai/deepseek-v4.1-flash" },
      { model: "xai/grok-4.7", thinking: "high" },
    ])
  })
})
