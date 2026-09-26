import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths } from "@rubato/memory-core"

import { condenseSession } from "./transcript"
import {
  approveDream,
  pickSessions,
  readDreamState,
  rejectDream,
  runDream,
  sessionSinceMs,
  type SpawnChild,
} from "./runner"
import type { SessionFile } from "./stores"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dream-test-"))
  dirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })
}

function sessionFile(dir: string, cwd: string): string {
  const path = join(dir, "s.jsonl")
  const lines = [
    { type: "session", id: "s1", cwd, timestamp: "2026-09-25T00:00:00.000Z" },
    { type: "message", timestamp: "2026-09-25T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "왜 이렇게 됐어?" }] } },
    { type: "message", timestamp: "2026-09-25T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "원인은 X야." }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
    { type: "message", timestamp: "2026-09-25T00:00:03.000Z", message: { role: "toolResult", content: [{ type: "text", text: "a.txt" }] } },
    { type: "message", timestamp: "2026-09-25T00:00:04.000Z", message: { role: "toolResult", isError: true, content: [{ type: "text", text: "ENOENT: no such file" }] } },
    { type: "message", timestamp: "2026-09-25T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "그래서 Y로 고쳤어." }] } },
  ]
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"))
  return path
}

describe("condenseSession", () => {
  test("keeps the user's words and each turn's last reply; drops the work in between", () => {
    const dir = tempDir()
    const condensed = condenseSession(sessionFile(dir, dir), 0)!
    expect(condensed.markdown).toContain("왜 이렇게 됐어?")
    expect(condensed.markdown).toContain("그래서 Y로 고쳤어.")
    expect(condensed.markdown).not.toContain("원인은 X야.")
    expect(condensed.markdown).not.toContain("bash")
    expect(condensed.markdown).not.toContain("ENOENT")
    expect(condensed.markdown).not.toContain("secret")
  })

  test("reads only messages after the cursor", () => {
    const dir = tempDir()
    const condensed = condenseSession(sessionFile(dir, dir), Date.parse("2026-09-25T00:00:02.500Z"))!
    expect(condensed.messages).toBe(3)
    expect(condensed.markdown).not.toContain("왜 이렇게 됐어?")
  })
})

describe("runDream", () => {
  function store() {
    const root = tempDir()
    const paths = buildIdentityPaths(root, "demo")
    execFileSync("mkdir", ["-p", paths.repo])
    git(paths.repo, "init", "-q", "-b", "main")
    writeFileSync(join(paths.repo, "a.md"), "old\n")
    git(paths.repo, "add", "-A")
    git(paths.repo, "commit", "-q", "-m", "init")
    return { root, paths }
  }

  function session(dir: string, id: string, lastAt: string, text = "왜?"): SessionFile {
    const path = join(dir, `${id}.jsonl`)
    const lines = [
      { type: "session", id, cwd: dir, timestamp: "2026-09-25T00:00:00.000Z" },
      { type: "message", timestamp: lastAt, message: { role: "user", content: [{ type: "text", text }] } },
    ]
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"))
    return { id, path, cwd: dir, mtimeMs: Date.now() }
  }

  // Stands in for the engine: "ok/model" edits, commits and reports; "half/model" commits then dies;
  // anything else dies with uncommitted edits.
  const fakeChild: SpawnChild = async ({ args, cwd, env, logPath }) => {
    writeFileSync(logPath, args.join(" "))
    const model = args[args.indexOf("--model") + 1]
    if (model === "ok/model") {
      writeFileSync(join(cwd, "a.md"), "new\n")
      git(cwd, "add", "-A")
      git(cwd, "commit", "-q", "-m", "dream: edit")
      writeFileSync(join(env.OUT_DIR!, "report.md"), "## 요약\n")
      return { code: 0 }
    }
    writeFileSync(join(cwd, "a.md"), "half-written by a failing rung\n")
    if (model === "half/model") {
      git(cwd, "add", "-A")
      git(cwd, "commit", "-q", "-m", "dream: partial")
    }
    return { code: 1 }
  }

  const run = (paths: ReturnType<typeof store>["paths"], sessions: SessionFile[], extra: Partial<Parameters<typeof runDream>[0]> = {}) =>
    runDream({
      store: "demo",
      paths,
      sessions,
      ladder: [{ model: "ok/model" }],
      launch: { command: "unused", prefixArgs: [] },
      systemPrompt: "p",
      env: process.env,
      spawnChild: fakeChild,
      ...extra,
    })

  test("under review the edits wait on a branch; approval lands them", async () => {
    const { root, paths } = store()
    const record = await run(paths, [session(root, "s1", "2026-09-25T00:00:04.000Z")], { ladder: [{ model: "dead/model" }, { model: "ok/model" }] })
    expect(record.status).toBe("pending")
    expect(record.model).toBe("ok/model")
    expect(readFileSync(join(paths.repo, "a.md"), "utf8")).toBe("old\n")
    await approveDream(paths, "demo", process.env)
    expect(readFileSync(join(paths.repo, "a.md"), "utf8")).toBe("new\n")
    expect(git(paths.repo, "branch", "--list", "dream/*").trim()).toBe("")
  })

  test("rejecting drops the edits and a new dream can run", async () => {
    const { root, paths } = store()
    await run(paths, [session(root, "s1", "2026-09-25T00:00:04.000Z")])
    const later = new Date(Date.now() + 60_000).toISOString()
    const blocked = await run(paths, [session(root, "s2", later)])
    expect(blocked.status).toBe("failed")
    await rejectDream(paths, "demo", process.env)
    expect(readFileSync(join(paths.repo, "a.md"), "utf8")).toBe("old\n")
    expect((await run(paths, [session(root, "s2", later)])).status).toBe("pending")
  })

  test("auto publish merges", async () => {
    const { root, paths } = store()
    const record = await run(paths, [session(root, "s1", "2026-09-25T00:00:04.000Z")], { publish: "auto" })
    expect(record.reason).toBeUndefined()
    expect(record.status).toBe("merged")
    expect(readFileSync(join(paths.repo, "a.md"), "utf8")).toBe("new\n")
  })

  test("a child that committed and then failed publishes nothing and reads nothing", async () => {
    const { root, paths } = store()
    const record = await run(paths, [session(root, "s1", "2026-09-25T00:00:04.000Z")], { ladder: [{ model: "half/model" }], publish: "auto" })
    expect(record.status).toBe("failed")
    expect(readFileSync(join(paths.repo, "a.md"), "utf8")).toBe("old\n")
    expect(git(paths.repo, "branch", "--list", "dream/*").trim()).toBe("")
    expect(await readDreamState(paths)).toEqual({})
  })

  test("a session left out for budget is read in full next time", async () => {
    const { root, paths } = store()
    const early = session(root, "early", "2026-09-25T00:00:01.000Z", "a".repeat(100))
    const late = session(root, "late", "2026-09-25T00:00:09.000Z", "b".repeat(100))
    const first = await run(paths, [early, late], { transcriptBudgetChars: 150, publish: "auto" })
    expect(first.sessions.map((s) => s.id)).toEqual(["early"])
    const state = await readDreamState(paths)
    const second = pickSessions([late], (id) => sessionSinceMs(state, id, Date.now()), 10_000)
    expect(second.map((s) => s.header.id)).toEqual(["late"])
    expect(second[0]!.markdown).toContain("b".repeat(100))
  })

  test("a trial child starts from the base tree and cannot see later history", async () => {
    const { root, paths } = store()
    const base = git(paths.repo, "rev-parse", "HEAD").trim()
    writeFileSync(join(paths.repo, "later.md"), "landed after the base\n")
    git(paths.repo, "add", "-A")
    git(paths.repo, "commit", "-q", "-m", "later")
    let seen = ""
    const record = await run(paths, [session(root, "s1", "2026-09-25T00:00:04.000Z")], {
      trial: { baseRevision: base },
      spawnChild: async (input) => {
        seen = `${readFileSync(join(input.cwd, "a.md"), "utf8")}|${git(input.cwd, "log", "--all", "--format=%s").trim()}`
        return fakeChild(input)
      },
    })
    expect(record.status).toBe("trial")
    expect(seen).toBe("old\n|init")
    expect(git(paths.repo, "show", `${record.branch!}:a.md`)).toBe("new\n")
  })

  test("a due run with nothing new does not start a child", async () => {
    const { paths } = store()
    let spawned = 0
    const record = await run(paths, [], { spawnChild: async () => { spawned += 1; return { code: 0 } } })
    expect(record.status).toBe("noop")
    expect(spawned).toBe(0)
  })
})

describe("scanStoreSessions store rule", () => {
  test("groups sessions by git project root, home and config name; folders outside all three have no store", async () => {
    const { mkdirSync, realpathSync } = await import("node:fs")
    const { createStoreNameResolver, scanStoreSessions } = await import("./stores")
    const root = realpathSync.native(tempDir())
    const home = join(root, "home")
    const repo = join(root, "work", "hash-game")
    const plain = join(root, "scratch")
    const named = join(root, "lab")
    for (const dir of [home, join(repo, "src"), plain, named]) mkdirSync(dir, { recursive: true })
    git(repo, "init", "-q")
    const sessions = join(root, "sessions")
    mkdirSync(sessions)
    const write = (id: string, cwd: string) =>
      writeFileSync(join(sessions, `${id}.jsonl`), JSON.stringify({ type: "session", id, cwd, timestamp: "2026-09-25T00:00:00.000Z" }))
    write("in-repo", join(repo, "src"))
    write("at-home", home)
    write("plain", plain)
    write("named", named)

    const env = { RUBATO_MEMORY_HOME: join(root, "memory"), HOME: home }
    const scan = scanStoreSessions({
      sessionsRoot: sessions,
      sinceMs: () => 0,
      resolveStore: createStoreNameResolver((cwd) => (cwd === named ? "rubato" : undefined), env),
    })

    const byStore = Object.fromEntries([...scan.sessions].map(([store, list]) => [store, list.map((session) => session.id)]))
    expect(byStore).toEqual({ "hash-game": ["in-repo"], home: ["at-home"], rubato: ["named"] })
  })
})
