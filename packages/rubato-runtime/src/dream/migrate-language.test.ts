import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { buildIdentityPaths, createLockRecord, memoryWriterLockPath, withLock } from "@rubato/memory-core"

import {
  LANGUAGE_MIGRATION_ID,
  languageMigrationDue,
  packBatches,
  readMigrations,
  runLanguageMigration,
} from "./migrate-language"
import { dreamLockPath, revertDream, type SpawnChild } from "./runner"
import { verbatimSegments } from "./verbatim"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })
}

// Korean records and the translation a well-behaved model writes for them.
const RECORDS: Record<string, { ko: string; en: string }> = {
  "decisions/cache.md": {
    ko: "---\ndescription: 캐시 접두를 고정하는 이유\n---\n## 결론\n- 접두는 고정한다. 사용자는 \"캐시 98% 조건\" 을 걸었다.\n\n## 증상\n프롬프트 캐시 히트가 또 떨어졌다\n",
    en: "---\ndescription: Why the cache prefix stays fixed\n---\n## Conclusion\n- The prefix stays fixed. The user set \"캐시 98% 조건\".\n\n## Symptom\n프롬프트 캐시 히트가 또 떨어졌다\n",
  },
  "reference/engine.md": {
    ko: "## 결론\n- 엔진은 stock pi 다.\n\n> 센파이 쓰면 안 됨\n",
    en: "## Conclusion\n- The engine is stock pi.\n\n> 센파이 쓰면 안 됨\n",
  },
}
const UNTOUCHED = {
  "reference/english.md": "## Conclusion\n- already English\n",
  "system/legacy.md": "## 옛 시스템 파일\n- 그대로 둔다\n",
}

function store() {
  const root = mkdtempSync(join(tmpdir(), "dream-migrate-test-"))
  dirs.push(root)
  const paths = buildIdentityPaths(root, "demo")
  mkdirSync(paths.repo, { recursive: true })
  git(paths.repo, "init", "-q", "-b", "main")
  const files = { ...Object.fromEntries(Object.entries(RECORDS).map(([path, record]) => [path, record.ko])), ...UNTOUCHED }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(paths.repo, path)), { recursive: true })
    writeFileSync(join(paths.repo, path), text)
  }
  git(paths.repo, "add", "-A")
  git(paths.repo, "commit", "-q", "-m", "init")
  return { root, paths }
}

type Translate = (path: string, english: string) => string

/** Stands in for the engine: writes each batch file's English, passed through `edit` per model. */
function child(edits: Record<string, Translate> = {}, extra?: (cwd: string) => void): { spawn: SpawnChild; calls: string[] } {
  const calls: string[] = []
  const spawn: SpawnChild = async ({ args, cwd, env, logPath }) => {
    const model = args[args.indexOf("--model") + 1]!
    calls.push(model)
    writeFileSync(logPath, `child ${model}\n`)
    if (model.startsWith("dead/")) return { code: 1 }
    const batch = JSON.parse(readFileSync(env.MIGRATE_BATCH!, "utf8")) as { files: string[] }
    const edit = edits[model] ?? ((_path: string, english: string) => english)
    for (const path of batch.files) writeFileSync(join(cwd, path), edit(path, RECORDS[path]!.en))
    extra?.(cwd)
    return { code: 0 }
  }
  return { spawn, calls }
}

const migrate = (paths: ReturnType<typeof store>["paths"], spawnChild: SpawnChild, ladder = [{ model: "ok/model" }]) =>
  runLanguageMigration({
    store: "demo", paths, ladder, spawnChild,
    launch: { command: "unused", prefixArgs: [] }, systemPrompt: "p", env: process.env,
  })

const read = (paths: ReturnType<typeof store>["paths"], path: string) => readFileSync(join(paths.repo, path), "utf8")

describe("runLanguageMigration", () => {
  test("#given a Korean store #when migrated #then records land in English in one merge, user words byte-identical, system/ and English files untouched, and it is marked done", async () => {
    const { paths } = store()
    const { spawn, calls } = child()
    const run = await migrate(paths, spawn)

    expect(run.status).toBe("merged")
    expect(run.kind).toBe("language-migration")
    expect(calls).toEqual(["ok/model"])
    for (const [path, record] of Object.entries(RECORDS)) {
      expect(read(paths, path)).toBe(record.en)
      expect(verbatimSegments(read(paths, path))).toEqual(verbatimSegments(record.ko))
    }
    for (const [path, text] of Object.entries(UNTOUCHED)) expect(read(paths, path)).toBe(text)
    expect(git(paths.repo, "log", "-1", "--format=%s %an")).toBe(`merge(dream): ${run.runId} dream\n`)
    expect(readFileSync(join(paths.runtime, "dream", "runs", run.runId, "out", "report.md"), "utf8")).toContain("`decisions/cache.md`: rewritten")
    expect((await readMigrations(paths)).done?.[LANGUAGE_MIGRATION_ID]).toMatchObject({ status: "merged", runId: run.runId })
    expect(await languageMigrationDue(paths, Date.now(), 0)).toBe(false)
  })

  test("#given a store already in English #when migrated #then no model runs and it is marked done", async () => {
    const { paths } = store()
    await migrate(paths, child().spawn)
    const head = git(paths.repo, "rev-parse", "HEAD")
    const { spawn, calls } = child()
    const again = await migrate(paths, spawn)
    expect(again.status).toBe("noop")
    expect(calls).toEqual([])
    expect(git(paths.repo, "rev-parse", "HEAD")).toBe(head)
  })

  test("#given a model that rewords the user's words #when its batch is checked #then it is thrown away and the next model's lands", async () => {
    const { paths } = store()
    const { spawn, calls } = child({ "sloppy/model": (_path, english) => english.replace("프롬프트 캐시 히트가 또 떨어졌다", "The prompt cache hit rate dropped again").replace("센파이 쓰면 안 됨", "do not use Senpi") })
    const run = await migrate(paths, spawn, [{ model: "sloppy/model" }, { model: "ok/model" }])
    expect(run.status).toBe("merged")
    expect(calls).toEqual(["sloppy/model", "ok/model"])
    expect(run.attempts?.[0]).toMatchObject({ model: "sloppy/model", ok: false })
    expect(run.attempts?.[0]?.error).toContain("symptom text changed")
    expect(read(paths, "decisions/cache.md")).toBe(RECORDS["decisions/cache.md"]!.en)
  })

  test("#given every model fails the check or touches system/ #when migrated #then nothing lands, the failure is recorded and retried only after the gap", async () => {
    const { paths } = store()
    const head = git(paths.repo, "rev-parse", "HEAD")
    const intruder = child({}, (cwd) => writeFileSync(join(cwd, "system/legacy.md"), "## legacy\n- translated\n"))
    const run = await migrate(paths, intruder.spawn, [{ model: "dead/model" }, { model: "ok/model" }])
    expect(run.status).toBe("failed")
    expect(run.attempts?.map((attempt) => attempt.ok)).toEqual([false, false])
    expect(run.attempts?.[1]?.error).toContain("system/legacy.md: changed outside the batch")
    expect(git(paths.repo, "rev-parse", "HEAD")).toBe(head)
    expect(read(paths, "system/legacy.md")).toBe(UNTOUCHED["system/legacy.md"])
    expect(git(paths.repo, "branch", "--list", "dream/*")).toBe("")
    expect((await readMigrations(paths)).done).toBeUndefined()
    expect(await languageMigrationDue(paths, Date.now(), 60 * 60_000)).toBe(false)
    expect(await languageMigrationDue(paths, Date.now() + 2 * 60 * 60_000, 60 * 60_000)).toBe(true)
  })

  test("#given a dream already running for the store #when the migration starts #then it reports busy and changes nothing", async () => {
    const { paths } = store()
    mkdirSync(paths.locks, { recursive: true })
    const { spawn, calls } = child()
    const run = await withLock(dreamLockPath(paths), await createLockRecord("dream (demo)"), () => migrate(paths, spawn))
    expect(run.status).toBe("busy")
    expect(calls).toEqual([])
    expect(await readMigrations(paths)).toEqual({})
  })

  test("#given a session holding the writer lock #when the migration lands #then it waits for the lock, and lands after it is released", async () => {
    const { paths } = store()
    mkdirSync(paths.locks, { recursive: true })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const writer = withLock(memoryWriterLockPath(paths.locks), await createLockRecord("session write"), async () => {
      entered()
      await held
    })
    await inside
    const pending = migrate(paths, child().spawn)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = git(paths.repo, "log", "-1", "--format=%s")
    release()
    await writer
    const run = await pending
    expect(before).toBe("init\n")
    expect(run.status).toBe("merged")
  })

  test("#given a landed migration #when reverted #then the Korean records come back in one revert commit and it does not run again", async () => {
    const { paths } = store()
    const run = await migrate(paths, child().spawn)
    await revertDream(paths, "demo", run.runId, process.env)
    for (const [path, record] of Object.entries(RECORDS)) expect(read(paths, path)).toBe(record.ko)
    expect(git(paths.repo, "log", "-1", "--format=%s")).toStartWith("Revert \"merge(dream): ")
    expect(await languageMigrationDue(paths, Date.now(), 0)).toBe(false)
  })

  test("#given a caller that read the marker before a run finished and was reverted #when it migrates #then the lock-side check stops it; only force runs again", async () => {
    const { paths } = store()
    expect(await languageMigrationDue(paths, Date.now(), 0)).toBe(true)
    const first = await migrate(paths, child().spawn)
    await revertDream(paths, "demo", first.runId, process.env)
    const { spawn, calls } = child()
    const stale = await migrate(paths, spawn)
    expect(stale).toMatchObject({ status: "noop", reason: `already migrated by ${first.runId}` })
    expect(calls).toEqual([])
    expect(read(paths, "decisions/cache.md")).toBe(RECORDS["decisions/cache.md"]!.ko)
    const forced = await runLanguageMigration({
      store: "demo", paths, ladder: [{ model: "ok/model" }], spawnChild: spawn, force: true,
      launch: { command: "unused", prefixArgs: [] }, systemPrompt: "p", env: process.env,
    })
    expect(forced.status).toBe("merged")
    expect(read(paths, "decisions/cache.md")).toBe(RECORDS["decisions/cache.md"]!.en)
  })

  test("#given many files #when batched #then batches stay near the budget and a big file goes alone", () => {
    expect(packBatches([{ path: "b", size: 10 }, { path: "a", size: 10 }, { path: "c", size: 50 }, { path: "d", size: 5 }], 25))
      .toEqual([["a", "b"], ["c"], ["d"]])
  })
})

test("migration leaves no worktree behind", async () => {
  const { paths } = store()
  const run = await migrate(paths, child().spawn)
  expect(existsSync(join(paths.worktrees, run.runId))).toBe(false)
})
