// The shared user memory end to end, on isolated stores. Model turns are FIXTURES: the spawned "engine"
// below is a small deterministic script that does what the personas ask (notice, curate, answer), so
// these tests prove what the runners do with a model's work (landing, evidence, forgetting, summary,
// concurrency), not what a real model would write.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { USER_STORE_ID, buildIdentityPaths } from "@rubato/memory-core"

import { runDream, type SpawnChild } from "../dream/runner"
import type { SessionFile } from "../dream/stores"
import { listExistingStores } from "../dream/stores"
import { recordForgetsAgain, runUserAsk } from "./ask"
import { readLedger } from "./ledger"
import { parseEvidence, parseRecord } from "./records"
import { userStore } from "./store"
import { mergeSummary, readSummary } from "./summary"
import { runUserDream, userDreamDue } from "./user-dream"
import { composeUserView } from "./view"

// Each test runs several real git repositories and runners end to end; a busy machine takes seconds.
setDefaultTimeout(60_000)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "user-memory-test-"))
  dirs.push(root)
  const memoryRoot = join(root, "memory")
  const project = (name: string) => {
    const paths = buildIdentityPaths(memoryRoot, name)
    mkdirSync(paths.repo, { recursive: true })
    git(paths.repo, "init", "-q", "-b", "main")
    writeFileSync(join(paths.repo, "decisions.md"), `${name} decisions\n`)
    git(paths.repo, "add", "-A")
    git(paths.repo, "commit", "-q", "-m", "init")
    return paths
  }
  return { root, memoryRoot, project, user: userStore(memoryRoot) }
}

function sessionFile(dir: string, id: string, turns: readonly [string, string][]): SessionFile {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  const lines: unknown[] = [{ type: "session", id, cwd: dir, timestamp: "2026-09-20T00:00:00.000Z" }]
  for (const [at, text] of turns) {
    lines.push({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } })
    lines.push({ type: "message", timestamp: at.replace(/Z$/, "1Z").replace(/\.\d+1Z$/, ".500Z"), message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })
  }
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"))
  return { id, path, cwd: dir, mtimeMs: Date.now() }
}

// FIXTURE project dream: notices, as the persona asks, every user line that starts with "I " or "나는 ".
const noticingChild = (extra: (cwd: string) => void = () => undefined): SpawnChild => async ({ cwd, env, logPath }) => {
  writeFileSync(logPath, "fixture project dream\n")
  const lines: string[] = []
  for (const file of readdirSync(env.TRANSCRIPTS_DIR!)) {
    const text = readFileSync(join(env.TRANSCRIPTS_DIR!, file), "utf8")
    const session = /session: (\S+)/.exec(text)?.[1]
    for (const match of text.matchAll(/## user · \S+\n\n(.+)\n/g)) {
      const said = match[1]!
      const claim = said.match(/^claim:(.+?)\|/)?.[1]
      if (claim !== undefined) lines.push(JSON.stringify({ claim: claim.trim(), quote: said, session }))
    }
  }
  writeFileSync(join(env.OUT_DIR!, "user-observations.jsonl"), `${lines.join("\n")}\n`)
  extra(cwd)
  return { code: 0 }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
}

// FIXTURE user dream: one record per observation claim (and per legacy profile line), Korean summary lines.
const curatingChild = (hook: () => unknown = () => undefined): SpawnChild => async ({ cwd, env, logPath }) => {
  writeFileSync(logPath, "fixture user dream\n")
  await hook()
  const inputs = env.INPUTS_DIR!
  const items: Record<string, string> = {}
  const write = (path: string, claim: string, evidence: string) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true })
    writeFileSync(join(cwd, path), `---\ndescription: ${claim}\n---\n\n## Conclusion\n- ${claim}\n\n## Evidence\n- ${evidence}\n`)
    items[path] = `기억: ${claim}`
  }
  const observations = readFileSync(join(inputs, "observations.md"), "utf8")
  for (const block of observations.split(/\n## \d+\n/).slice(1)) {
    const claim = /- claim: (.+)/.exec(block)?.[1]
    if (claim === undefined) continue
    const said = /- said: "(.+)"/.exec(block)?.[1] ?? claim
    const when = /- when: (\S+)/.exec(block)?.[1]?.slice(0, 10) ?? "2026-01-01"
    const project = /- project: (\S+)/.exec(block)?.[1] ?? "unknown"
    write(`preferences/${slug(claim)}.md`, claim, `${when} · project \`${project}\` · "${said}"`)
  }
  if (existsSync(join(inputs, "legacy-profile.md"))) {
    for (const line of readFileSync(join(inputs, "legacy-profile.md"), "utf8").split("\n").map((entry) => entry.replace(/^-\s*/, "").trim()).filter(Boolean)) {
      write(`background/${slug(line)}.md`, line, `2026-09-01 · legacy profile · "${line}"`)
    }
  }
  if (Object.keys(items).length === 0) return { code: 0 }
  git(cwd, "add", "-A")
  git(cwd, "commit", "-q", "-m", "dream: user memory")
  writeFileSync(join(env.OUT_DIR!, "report.md"), "## Summary\nfixture\n")
  writeFileSync(join(env.OUT_DIR!, "summary.json"), JSON.stringify({ language: "ko", topics: { preferences: "선호", background: "배경" }, items }))
  return { code: 0 }
}

// FIXTURE steward: reads the request and acts on its leading verb: WHY / CORRECT <text> / FORGET <terms,...> / REMEMBER <claim>.
const stewardChild: SpawnChild = async ({ cwd, env, logPath }) => {
  writeFileSync(logPath, "fixture steward\n")
  const request = JSON.parse(readFileSync(env.REQUEST_PATH!, "utf8")) as { text: string; focus?: { path: string } | null }
  const out = env.OUT_DIR!
  const [verb, ...rest] = request.text.split(" ")
  const argument = rest.join(" ")
  const focus = request.focus?.path
  const result: { forget: unknown[]; summary: { items: Record<string, string> } } = { forget: [], summary: { items: {} } }
  if (verb === "WHY" && focus !== undefined) {
    const evidence = parseRecord(focus, readFileSync(join(cwd, focus), "utf8")).evidence[0]
    writeFileSync(join(out, "reply.md"), `${evidence?.date}에 ${evidence?.where}에서 "${evidence?.quote}"라고 하셔서 기억하고 있어요.`)
  } else if (verb === "CORRECT" && focus !== undefined) {
    const text = readFileSync(join(cwd, focus), "utf8").replace(/## Conclusion\n- .+/, `## Conclusion\n- ${argument}`).replace("## Evidence\n", `## Evidence\n- ${env.TODAY} · Settings > Memory · "${request.text}"\n`)
    writeFileSync(join(cwd, focus), text)
    result.summary.items[focus] = `기억: ${argument}`
    writeFileSync(join(out, "reply.md"), `고쳤어요. 이제 "${argument}"로 기억해요.`)
  } else if (verb === "FORGET" && focus !== undefined) {
    rmSync(join(cwd, focus))
    result.forget.push({ what: `the claim in ${focus}`, terms: argument.split(",") })
    writeFileSync(join(out, "reply.md"), "잊었어요.")
  } else if (verb === "REMEMBER") {
    mkdirSync(join(cwd, "preferences"), { recursive: true })
    const path = `preferences/${slug(argument)}.md`
    writeFileSync(join(cwd, path), `---\ndescription: ${argument}\n---\n\n## Conclusion\n- ${argument}\n\n## Evidence\n- ${env.TODAY} · Settings > Memory · "${request.text}"\n`)
    result.summary.items[path] = `기억: ${argument}`
    writeFileSync(join(out, "reply.md"), "기억할게요.")
  } else if (verb === "LIE") {
    writeFileSync(join(out, "reply.md"), "잊었어요.")
    result.forget.push({ what: "something still there", terms: [argument] })
  } else {
    writeFileSync(join(out, "reply.md"), "무엇을 바꿀까요?")
  }
  writeFileSync(join(out, "result.json"), JSON.stringify(result))
  if (git(cwd, "status", "--porcelain").trim() !== "") {
    git(cwd, "add", "-A")
    git(cwd, "commit", "-q", "-m", `ask: ${verb}`)
  }
  return { code: 0 }
}

const launch = { command: "unused", prefixArgs: [] }
const NOW = Date.parse("2026-10-01T00:00:00.000Z")

function projectDream(memoryRoot: string, store: string, sessions: SessionFile[], child: SpawnChild = noticingChild(), now = NOW) {
  return runDream({
    store,
    paths: buildIdentityPaths(memoryRoot, store),
    sessions,
    ladder: [{ model: "fixture/model" }],
    launch,
    systemPrompt: "p",
    env: process.env,
    spawnChild: child,
    now: () => now,
  })
}

function userDream(memoryRoot: string, child: SpawnChild = curatingChild(), extra: Partial<Parameters<typeof runUserDream>[0]> = {}) {
  return runUserDream({ memoryRoot, ladder: [{ model: "fixture/model" }], launch, systemPrompt: "p", env: process.env, spawnChild: child, now: () => NOW, ...extra })
}

async function ask(memoryRoot: string, id: string, text: string, focus?: string, now = NOW) {
  const store = userStore(memoryRoot)
  mkdirSync(join(store.asks, id), { recursive: true })
  writeFileSync(join(store.asks, id, "request.json"), JSON.stringify({ id, text, focus: focus === undefined ? null : { path: focus }, createdAt: new Date(now).toISOString() }))
  return runUserAsk({ memoryRoot, id, ladder: [{ model: "fixture/model" }], launch, systemPrompt: "p", env: process.env, spawnChild: stewardChild, now: () => now })
}

function userFiles(memoryRoot: string): string[] {
  const repo = userStore(memoryRoot).paths.repo
  return git(repo, "ls-files").split("\n").filter(Boolean).sort()
}

describe("user facts are noticed in every project and curated into one shared store", () => {
  test("observations from two projects land automatically, with the user's words and when they were said", async () => {
    const w = world()
    w.project("alpha")
    w.project("beta")
    const a = sessionFile(join(w.root, "alpha"), "sa", [["2026-09-28T01:00:00.000Z", "claim: Prefers short answers | 짧게 말해줘"]])
    const b = sessionFile(join(w.root, "beta"), "sb", [["2026-09-29T02:00:00.000Z", "claim: Works on macOS | 나는 맥에서 일해"]])

    expect((await projectDream(w.memoryRoot, "alpha", [a])).status).toBe("noop")
    expect((await projectDream(w.memoryRoot, "beta", [b])).status).toBe("noop")
    expect(await userDreamDue(w.memoryRoot, NOW, 0)).toBe(true)
    const record = await userDream(w.memoryRoot)

    expect(record.status).toBe("merged")
    expect(userFiles(w.memoryRoot)).toEqual(["preferences/prefers-short-answers.md", "preferences/works-on-macos.md"])
    const short = parseRecord("x", readFileSync(join(w.user.paths.repo, "preferences/prefers-short-answers.md"), "utf8"))
    expect(short.evidence[0]).toMatchObject({ date: "2026-09-28", where: "project alpha", quote: "claim: Prefers short answers | 짧게 말해줘" })
    // Project memories stay where they were: no user fact went into a project store.
    expect(git(buildIdentityPaths(w.memoryRoot, "alpha").repo, "ls-files").trim()).toBe("decisions.md")
    // Taken once: nothing waits, and a second run has nothing to do.
    expect(await userDreamDue(w.memoryRoot, NOW, 0)).toBe(false)
    expect((await userDream(w.memoryRoot)).reason).toBe("nothing new about the user")
    // The user store is not a project.
    expect(listExistingStores(w.memoryRoot)).toEqual(["alpha", "beta"])
  })

  test("a quote that is not in the session gets no time of its own", async () => {
    const w = world()
    w.project("alpha")
    const a = sessionFile(join(w.root, "alpha"), "sa", [["2026-09-28T01:00:00.000Z", "hello"]])
    await projectDream(w.memoryRoot, "alpha", [a], async ({ env }) => {
      writeFileSync(join(env.OUT_DIR!, "user-observations.jsonl"), `${JSON.stringify({ claim: "Invented", quote: "never said", session: "sa" })}\nnot json\n`)
      return { code: 0 }
    })
    const runs = readdirSync(join(buildIdentityPaths(w.memoryRoot, "alpha").runtime, "dream", "runs"))
    const saved = JSON.parse(readFileSync(join(buildIdentityPaths(w.memoryRoot, "alpha").runtime, "dream", "runs", runs[0]!, "user-observations.json"), "utf8"))
    expect(saved).toEqual([expect.objectContaining({ claim: "Invented", quote: "never said", session: "sa", project: "alpha" })])
    expect(saved[0].at).toBeUndefined()
  })

  test("two user dreams at once: one lands, the other finds the lock and leaves the rest for later", async () => {
    const w = world()
    w.project("alpha")
    w.project("beta")
    await projectDream(w.memoryRoot, "alpha", [sessionFile(join(w.root, "alpha"), "sa", [["2026-09-28T01:00:00.000Z", "claim: Likes tables | 표로 보여줘"]])])
    let second: Awaited<ReturnType<typeof userDream>> | undefined
    const first = await userDream(w.memoryRoot, curatingChild(async () => {
      // While the first is curating, beta's dream finishes and asks for a user dream too.
      await projectDream(w.memoryRoot, "beta", [sessionFile(join(w.root, "beta"), "sb", [["2026-09-29T01:00:00.000Z", "claim: Uses Korean | 한국어로 해"]])])
      second = await userDream(w.memoryRoot)
    }))

    expect(first.status).toBe("merged")
    expect(second?.status).toBe("busy")
    expect(userFiles(w.memoryRoot)).toEqual(["preferences/likes-tables.md"])
    const later = await userDream(w.memoryRoot)
    expect(later.status).toBe("merged")
    expect(userFiles(w.memoryRoot)).toEqual(["preferences/likes-tables.md", "preferences/uses-korean.md"])
  })

  test("a failed user dream lands nothing, keeps its inputs, and waits before trying again", async () => {
    const w = world()
    w.project("alpha")
    await projectDream(w.memoryRoot, "alpha", [sessionFile(join(w.root, "alpha"), "sa", [["2026-09-28T01:00:00.000Z", "claim: Likes tables | 표"]])])
    const failed = await userDream(w.memoryRoot, async ({ cwd, logPath }) => {
      writeFileSync(logPath, "provider said no\n")
      writeFileSync(join(cwd, "half.md"), "half\n")
      return { code: 1 }
    })
    expect(failed.status).toBe("failed")
    expect(userFiles(w.memoryRoot)).toEqual([])
    expect(await userDreamDue(w.memoryRoot, NOW + 1000, 60 * 60_000)).toBe(false)
    expect(await userDreamDue(w.memoryRoot, NOW + 2 * 60 * 60_000, 60 * 60_000)).toBe(true)
    expect((await userDream(w.memoryRoot, curatingChild(), { now: () => NOW + 2 * 60 * 60_000, retryGapMs: 60 * 60_000 })).status).toBe("merged")
  })
})

describe("asking about, correcting and forgetting what is remembered", () => {
  async function remembered() {
    const w = world()
    w.project("alpha")
    await projectDream(w.memoryRoot, "alpha", [sessionFile(join(w.root, "alpha"), "sa", [
      ["2026-09-28T01:00:00.000Z", "claim: Lives in Busan | 나 부산 살아"],
      ["2026-09-28T02:00:00.000Z", "claim: Prefers short answers | 짧게"],
    ])])
    expect((await userDream(w.memoryRoot)).status).toBe("merged")
    return w
  }
  const BUSAN = "preferences/lives-in-busan.md"
  const SHORT = "preferences/prefers-short-answers.md"

  test("why: the answer comes from the stored evidence and nothing changes", async () => {
    const w = await remembered()
    const before = git(w.user.paths.repo, "rev-parse", "HEAD")
    const result = await ask(w.memoryRoot, "q1", "WHY", SHORT)
    expect(result).toMatchObject({ status: "done", changes: [] })
    expect(result.reply).toContain("2026-09-28")
    expect(result.reply).toContain("project alpha")
    expect(git(w.user.paths.repo, "rev-parse", "HEAD")).toBe(before)
  })

  test("a correction changes the record, the summary line and what the page shows, and says what changed", async () => {
    const w = await remembered()
    const result = await ask(w.memoryRoot, "q2", "CORRECT Prefers short answers, except for design reviews", SHORT)
    expect(result.status).toBe("done")
    expect(result.changes).toEqual([{ path: SHORT, topic: "preferences", change: "modified", before: "기억: Prefers short answers", after: "기억: Prefers short answers, except for design reviews" }])
    expect(readFileSync(join(w.user.paths.repo, SHORT), "utf8")).toContain("- Prefers short answers, except for design reviews")
    expect(readFileSync(join(w.user.paths.repo, SHORT), "utf8")).toContain("Settings > Memory")
    const view = await composeUserView(w.memoryRoot, { now: NOW })
    const item = view.topics.flatMap((topic) => topic.items).find((entry) => entry.path === SHORT)
    expect(item).toMatchObject({ text: "기억: Prefers short answers, except for design reviews", summarized: true })
    expect(view.asks[0]).toMatchObject({ id: "q2", state: "done" })
  })

  test("forgetting removes it from the store and the summary, and no later dream brings it back from an old transcript", async () => {
    const w = await remembered()
    const forgot = await ask(w.memoryRoot, "q3", "FORGET Busan,부산", BUSAN, NOW + 1000)
    expect(forgot).toMatchObject({ status: "done", forgotten: [{ what: `the claim in ${BUSAN}` }] })
    expect(forgot.changes).toEqual([{ path: BUSAN, topic: "preferences", change: "deleted", before: "기억: Lives in Busan" }])
    expect(userFiles(w.memoryRoot)).toEqual([SHORT])
    expect(Object.keys((await readSummary(w.user)).items)).toEqual([SHORT])
    expect((await readLedger(w.user)).forgotten).toHaveLength(1)

    // A later project dream reads the old transcript again (a session touched after the forget, say).
    const old = sessionFile(join(w.root, "alpha2"), "old", [["2026-09-28T01:00:00.000Z", "claim: Lives in Busan | 나 부산 살아"]])
    w.project("gamma")
    expect((await projectDream(w.memoryRoot, "gamma", [old], noticingChild(), NOW + 5000)).status).toBe("noop")
    const after = await userDream(w.memoryRoot, curatingChild(), { now: () => NOW + 6000 })
    expect(after).toMatchObject({ status: "noop", blocked: 1 })
    expect(userFiles(w.memoryRoot)).toEqual([SHORT])
    const view = await composeUserView(w.memoryRoot, { now: NOW + 7000 })
    expect(JSON.stringify(view.topics)).not.toContain("Busan")
  })

  test("a dream that started before the forget and lands after it is refused", async () => {
    const w = await remembered()
    w.project("gamma")
    await projectDream(w.memoryRoot, "gamma", [sessionFile(join(w.root, "g"), "sg", [["2026-09-29T01:00:00.000Z", "claim: Uses vim | vim 써"]])], noticingChild(), NOW + 100)
    const stale = await userDream(w.memoryRoot, async (input) => {
      // Started from the store that still remembers Busan; it rewrites that record while the user forgets it.
      writeFileSync(join(input.cwd, "background-home.md"), "---\ndescription: Home city\n---\n\n## Conclusion\n- Lives in Busan, near the sea\n")
      await ask(w.memoryRoot, "q4", "FORGET Busan,부산", BUSAN, NOW + 200)
      return curatingChild()(input)
    }, { now: () => NOW + 300 })
    expect(stale.status).toBe("failed")
    expect(stale.reason).toContain("asked to forget")
    expect(userFiles(w.memoryRoot)).toEqual([SHORT])
    // Its observations wait for the next run, which lands them without the forgotten claim.
    const next = await userDream(w.memoryRoot, curatingChild(), { now: () => NOW + 400 })
    expect(next.status).toBe("merged")
    expect(userFiles(w.memoryRoot)).toEqual([SHORT, "preferences/uses-vim.md"])
  })

  test("saying it again after the forget is allowed", async () => {
    const w = await remembered()
    await ask(w.memoryRoot, "q5", "FORGET Busan,부산", BUSAN, NOW + 1000)
    const again = await ask(w.memoryRoot, "q6", "REMEMBER Lives in Busan again", undefined, NOW + 2000)
    expect(again.status).toBe("done")
    expect(userFiles(w.memoryRoot)).toContain("preferences/lives-in-busan-again.md")
  })

  test("a reply that claims a forget while the claim is still stored fails and changes nothing", async () => {
    const w = await remembered()
    const before = git(w.user.paths.repo, "rev-parse", "HEAD")
    const result = await ask(w.memoryRoot, "q7", "LIE Busan", BUSAN)
    expect(result.status).toBe("failed")
    expect(result.reason).toContain(BUSAN)
    expect(git(w.user.paths.repo, "rev-parse", "HEAD")).toBe(before)
    expect((await readLedger(w.user)).forgotten).toEqual([])
  })

  test("a forget is checked against the store as it will be: a copy another writer landed meanwhile fails it", async () => {
    const w = await remembered()
    const store = userStore(w.memoryRoot)
    mkdirSync(join(store.asks, "q8"), { recursive: true })
    writeFileSync(join(store.asks, "q8", "request.json"), JSON.stringify({ id: "q8", text: "FORGET Busan", focus: { path: BUSAN }, createdAt: new Date(NOW).toISOString() }))
    const result = await runUserAsk({
      memoryRoot: w.memoryRoot, id: "q8", ladder: [{ model: "fixture/model" }], launch, systemPrompt: "p", env: process.env, now: () => NOW,
      spawnChild: async (input) => {
        mkdirSync(join(w.user.paths.repo, "background"), { recursive: true })
        writeFileSync(join(w.user.paths.repo, "background/home.md"), "---\ndescription: Home\n---\n\n## Conclusion\n- Lives in Busan\n")
        git(w.user.paths.repo, "add", "-A")
        git(w.user.paths.repo, "commit", "-q", "-m", "another writer")
        return stewardChild(input)
      },
    })
    expect(result).toMatchObject({ status: "failed", forgotten: [] })
    expect(result.reason).toContain("background/home.md")
    expect((await readLedger(w.user)).forgotten).toEqual([])
    expect(userFiles(w.memoryRoot)).toContain(BUSAN)
  })

  test("a change that landed is reported as saved even when the summary cannot be written after it", async () => {
    const w = await remembered()
    rmSync(w.user.summary, { force: true })
    mkdirSync(w.user.summary, { recursive: true })
    const result = await ask(w.memoryRoot, "q9", "CORRECT Prefers short answers, except in design reviews", SHORT)
    expect(result.status).toBe("done")
    expect(result.problems).toEqual(["summary-stale"])
    expect(result.changes.map((change) => [change.path, change.change])).toEqual([[SHORT, "modified"]])
    expect(readFileSync(join(w.user.paths.repo, SHORT), "utf8")).toContain("except in design reviews")
  })

  test("a forget whose ledger write failed can be recorded again from that request, once the words are still gone", async () => {
    const w = await remembered()
    const store = userStore(w.memoryRoot)
    rmSync(store.ledger, { force: true })
    mkdirSync(store.ledger, { recursive: true })
    const result = await ask(w.memoryRoot, "q11", "FORGET Busan,부산", BUSAN, NOW + 1000)
    expect(result).toMatchObject({ status: "done", problems: ["forget-unrecorded"] })
    expect(userFiles(w.memoryRoot)).toEqual([SHORT])
    rmSync(store.ledger, { recursive: true, force: true })
    const again = await recordForgetsAgain(w.memoryRoot, "q11")
    expect(again.problems).toBeUndefined()
    expect((await readLedger(w.user)).forgotten.map((entry) => entry.terms)).toEqual([["Busan", "부산"]])
    await expect(recordForgetsAgain(w.memoryRoot, "q11")).rejects.toThrow("nothing left to record")
  })

  test("a run that dies after its change landed reads as saved, with what changed read from the store", async () => {
    const w = await remembered()
    const store = userStore(w.memoryRoot)
    const base = git(w.user.paths.repo, "rev-parse", "HEAD").trim()
    git(w.user.paths.repo, "rm", "-q", BUSAN)
    git(w.user.paths.repo, "commit", "-q", "-m", "merge(ask): q10")
    const revision = git(w.user.paths.repo, "rev-parse", "HEAD").trim()
    mkdirSync(join(store.asks, "q10"), { recursive: true })
    writeFileSync(join(store.asks, "q10", "request.json"), JSON.stringify({ id: "q10", text: "FORGET Busan", focus: { path: BUSAN }, createdAt: new Date(NOW).toISOString() }))
    writeFileSync(join(store.asks, "q10", "running.json"), JSON.stringify({ pid: 999_999_999 }))
    writeFileSync(join(store.asks, "q10", "landed.json"), JSON.stringify({ base, revision, at: new Date(NOW).toISOString() }))
    const view = await composeUserView(w.memoryRoot, { now: NOW, alive: () => false })
    expect(view.asks[0]).toMatchObject({ id: "q10", state: "done", result: { status: "done", problems: ["reply-lost"], changes: [{ path: BUSAN, change: "deleted", before: "기억: Lives in Busan" }] } })
  })

  test("one request at a time: a second while the first works is told to wait", async () => {
    const w = await remembered()
    let inner: Awaited<ReturnType<typeof ask>> | undefined
    const store = userStore(w.memoryRoot)
    mkdirSync(join(store.asks, "outer"), { recursive: true })
    writeFileSync(join(store.asks, "outer", "request.json"), JSON.stringify({ id: "outer", text: "WHY", focus: { path: SHORT }, createdAt: new Date(NOW).toISOString() }))
    const outer = await runUserAsk({
      memoryRoot: w.memoryRoot, id: "outer", ladder: [{ model: "fixture/model" }], launch, systemPrompt: "p", env: process.env, now: () => NOW,
      spawnChild: async (input) => {
        inner = await ask(w.memoryRoot, "inner", "WHY", SHORT)
        return stewardChild(input)
      },
    })
    expect(outer.status).toBe("done")
    expect(inner?.status).toBe("busy")
  })
})

describe("the transition keeps what the user already had", () => {
  test("a hand-kept user.md and waiting suggestions are carried in once; the files stay; dismissed lines stay out", async () => {
    const w = world()
    const alpha = w.project("alpha")
    const self = join(w.memoryRoot, "self", "repo")
    mkdirSync(self, { recursive: true })
    writeFileSync(join(self, "user.md"), "- Writes in Korean\n")
    writeFileSync(join(self, "soul.md"), "Calm.\n")
    writeFileSync(join(w.memoryRoot, "self", "dismissed-suggestions.json"), JSON.stringify({ lines: ["Hates tabs \"탭 싫어\""] }))
    const legacyRun = join(alpha.runtime, "dream", "runs", "dream-old")
    mkdirSync(join(legacyRun, "out"), { recursive: true })
    writeFileSync(join(legacyRun, "run.json"), JSON.stringify({ runId: "dream-old", status: "merged", startedAt: "2026-09-10T00:00:00.000Z" }))
    writeFileSync(join(legacyRun, "out", "user-candidates.md"), "- Likes tables \"표로\"\n- Hates tabs \"탭 싫어\"\n")

    const view = await composeUserView(w.memoryRoot, { now: NOW })
    expect(view).toMatchObject({ exists: false, count: 0, legacyProfile: "waiting", dream: { waiting: 1 } })
    expect((await userDream(w.memoryRoot)).status).toBe("merged")

    expect(userFiles(w.memoryRoot)).toEqual(["background/writes-in-korean.md", "preferences/likes-tables.md"])
    expect(readFileSync(join(self, "user.md"), "utf8")).toBe("- Writes in Korean\n")
    expect(readFileSync(join(self, "soul.md"), "utf8")).toBe("Calm.\n")
    expect(existsSync(join(legacyRun, "out", "user-candidates.md"))).toBe(true)
    expect((await composeUserView(w.memoryRoot, { now: NOW })).legacyProfile).toBe("carried")
    expect((await userDream(w.memoryRoot)).reason).toBe("nothing new about the user")
  })
})

describe("the view", () => {
  test("a record changed outside a curator shows its own conclusion until a summary line matches it again", async () => {
    const w = world()
    w.project("alpha")
    await projectDream(w.memoryRoot, "alpha", [sessionFile(join(w.root, "alpha"), "sa", [["2026-09-28T01:00:00.000Z", "claim: Likes tables | 표"]])])
    await userDream(w.memoryRoot)
    const path = join(w.user.paths.repo, "preferences/likes-tables.md")
    writeFileSync(path, readFileSync(path, "utf8").replace("- Likes tables", "- Likes tables and diagrams"))
    git(w.user.paths.repo, "commit", "-qam", "hand edit")
    const view = await composeUserView(w.memoryRoot, { now: NOW })
    expect(view.topics).toEqual([expect.objectContaining({ id: "preferences", title: "선호", items: [expect.objectContaining({ text: "Likes tables and diagrams", summarized: false })] })])
    expect(view.count).toBe(1)
    expect(view.revision).toMatch(/^[0-9a-f]{40}$/)
  })

  test("a curator that only describes records (no commit) still updates what the page reads", async () => {
    const w = world()
    w.project("alpha")
    await projectDream(w.memoryRoot, "alpha", [sessionFile(join(w.root, "alpha"), "sa", [["2026-09-28T01:00:00.000Z", "claim: Likes tables | 표"]])])
    await userDream(w.memoryRoot, async (input) => {
      await curatingChild()(input)
      writeFileSync(join(input.env.OUT_DIR!, "summary.json"), JSON.stringify({ items: {} }))
      return { code: 0 }
    })
    const record = await userDream(w.memoryRoot, async ({ env }) => {
      writeFileSync(join(env.OUT_DIR!, "summary.json"), JSON.stringify({ language: "ko", topics: { preferences: "선호" }, items: { "preferences/likes-tables.md": "표로 보는 걸 좋아해요." } }))
      return { code: 0 }
    }, { force: true })
    expect(record.status).toBe("noop")
    const view = await composeUserView(w.memoryRoot, { now: NOW })
    expect(view.topics[0]?.items[0]).toMatchObject({ text: "표로 보는 걸 좋아해요.", summarized: true })
  })

  test("a summary line attaches only to the version of the record it was written from", () => {
    const merged = mergeSummary({ topics: {}, items: {} }, { items: { "a.md": "old line", "b.md": "fresh line" } }, new Map([["a.md", "blob-new"], ["b.md", "blob-b"]]), new Map([["a.md", "blob-old"], ["b.md", "blob-b"]]))
    expect(merged.items).toEqual({ "b.md": { blob: "blob-b", text: "fresh line" } })
    expect(mergeSummary({ topics: {}, items: {} }, { items: { "b.md": "x" } }, new Map([["b.md", "blob-b"]])).items).toEqual({})
  })

  test("an empty memory reads as empty", async () => {
    const w = world()
    expect(await composeUserView(w.memoryRoot, { now: NOW })).toMatchObject({ exists: false, count: 0, topics: [], asks: [], legacyProfile: "none" })
    expect(USER_STORE_ID).toBe("user.shared")
  })
})

describe("records", () => {
  test("evidence lines read into date, place and the user's words", () => {
    expect(parseEvidence('2026-10-28 · project `rubato-lab` · "첫 문장이 곧 답이야."')).toEqual({
      raw: '2026-10-28 · project `rubato-lab` · "첫 문장이 곧 답이야."', date: "2026-10-28", where: "project rubato-lab", quote: "첫 문장이 곧 답이야.",
    })
    expect(parseEvidence("2026-10-29 · Settings > Memory · “그건 틀렸어”")).toMatchObject({ where: "Settings > Memory", quote: "그건 틀렸어" })
    expect(parseEvidence("something loose")).toEqual({ raw: "something loose", where: "something loose" })
  })
})
