// What Settings > Memory shows about the user, composed from the store as it is: topics, one line per
// record (the summary line when it was written from this very version of the record, else the record's
// own conclusion), the evidence behind each, the requests and their outcomes, and whether a dream is
// working on it. Read-only.

import { existsSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createNodeGitExec, selfRepoPath } from "@rubato/memory-core"

import type { Git } from "../dream/runner"
import { ASK_ID, type AskRequest, type AskResult } from "./ask"
import { collectPending, readInputsLedger } from "./observations"
import { listRecords, plainLine, type EvidenceLine } from "./records"
import { readJsonFile, userStore } from "./store"
import { readSummary } from "./summary"

const ASKS_SHOWN = 20

export interface UserMemoryItem {
  readonly path: string
  readonly text: string
  /** False when the line is the record's own (English) conclusion because no summary line matches this version yet. */
  readonly summarized: boolean
  readonly conclusion: readonly string[]
  readonly scope: readonly string[]
  readonly evidence: readonly EvidenceLine[]
  readonly updatedAt: string | null
}

export interface UserMemoryTopic {
  readonly id: string
  readonly title: string | null
  readonly items: readonly UserMemoryItem[]
}

export interface UserMemoryAsk {
  readonly id: string
  readonly text: string
  readonly focus: AskRequest["focus"] | null
  readonly createdAt: string
  readonly state: "working" | "done" | "failed" | "busy"
  readonly result: AskResult | null
}

export interface UserMemoryView {
  readonly exists: boolean
  readonly revision: string | null
  readonly updatedAt: string | null
  readonly language: string | null
  readonly topics: readonly UserMemoryTopic[]
  readonly count: number
  readonly dream: {
    readonly running: boolean
    readonly lastAt: string | null
    readonly lastStatus: string | null
    /** Project runs whose observations wait for the next user dream. */
    readonly waiting: number
  }
  /** A hand-kept user.md from before: whether its content was carried into the store yet. */
  readonly legacyProfile: "none" | "waiting" | "carried"
  readonly asks: readonly UserMemoryAsk[]
}

const TOPIC_ORDER = ["preferences", "working-style", "background", "constraints"]

export async function composeUserView(memoryRoot: string, options: { readonly now?: number; readonly alive?: (pid: number) => boolean } = {}): Promise<UserMemoryView> {
  const store = userStore(memoryRoot)
  const alive = options.alive ?? processAlive
  const exists = existsSync(join(store.paths.repo, ".git"))
  const exec = createNodeGitExec()
  const git: Git = async (cwd, argv) => exec.run(argv, { cwd, timeoutMs: 30_000 })
  const records = exists ? await listRecords(git, store.paths.repo, "HEAD") : []
  const summary = await readSummary(store)
  const revision = exists ? (await git(store.paths.repo, ["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim() || null : null
  const updatedAt = exists ? (await git(store.paths.repo, ["log", "-1", "--format=%cI"])).stdout.trim() || null : null
  const touched = exists ? await lastTouched(git, store.paths.repo) : new Map<string, string>()

  const byTopic = new Map<string, UserMemoryItem[]>()
  for (const record of records) {
    const line = summary.items[record.path]
    const summarized = line !== undefined && line.blob === record.blob
    const list = byTopic.get(record.topic) ?? []
    list.push({
      path: record.path,
      text: summarized ? line.text : plainLine(record),
      summarized,
      conclusion: record.conclusion,
      scope: record.scope,
      evidence: record.evidence,
      updatedAt: touched.get(record.path) ?? null,
    })
    byTopic.set(record.topic, list)
  }
  const rank = (topic: string) => (TOPIC_ORDER.includes(topic) ? TOPIC_ORDER.indexOf(topic) : TOPIC_ORDER.length)
  const topics = [...byTopic.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([id, items]) => ({ id, title: summary.topics[id] ?? null, items }))

  const inputs = await readInputsLedger(store)
  const pending = await collectPending(memoryRoot, store, options.now ?? Date.now())
  const lock = await readJsonFile<{ pid?: number }>(join(store.paths.locks, "dream.lock"))
  const legacyText = (await readFile(join(selfRepoPath(memoryRoot), "user.md"), "utf8").catch(() => "")).trim()
  return {
    exists,
    revision,
    updatedAt,
    language: summary.language ?? null,
    topics,
    count: records.length,
    dream: {
      running: typeof lock?.pid === "number" && alive(lock.pid),
      lastAt: inputs.lastAt ?? null,
      lastStatus: inputs.lastStatus ?? null,
      waiting: pending.runs.length,
    },
    legacyProfile: legacyText === "" ? "none" : pending.legacyProfile === undefined ? "carried" : "waiting",
    asks: await recentAsks(store.asks, alive),
  }
}

async function recentAsks(asksDir: string, alive: (pid: number) => boolean): Promise<UserMemoryAsk[]> {
  let names: string[] = []
  try {
    names = readdirSync(asksDir).filter((name) => ASK_ID.test(name))
  } catch {
    return []
  }
  const asks: UserMemoryAsk[] = []
  for (const id of names) {
    const dir = join(asksDir, id)
    const request = await readJsonFile<AskRequest>(join(dir, "request.json"))
    if (request === undefined || typeof request.text !== "string") continue
    const result = await readJsonFile<AskResult>(join(dir, "result.json")) ?? null
    const marker = await readJsonFile<{ pid?: number }>(join(dir, "running.json"))
    const running = typeof marker?.pid === "number" && alive(marker.pid)
    const state: UserMemoryAsk["state"] = result !== null ? result.status : running ? "working" : "failed"
    asks.push({
      id,
      text: request.text,
      focus: request.focus ?? null,
      createdAt: request.createdAt,
      state,
      result: result ?? (running ? null : { id, status: "failed", changes: [], forgotten: [], attempts: [], startedAt: request.createdAt, finishedAt: request.createdAt, reason: await lastLogLine(dir) }),
    })
  }
  return asks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, ASKS_SHOWN)
}

async function lastLogLine(dir: string): Promise<string> {
  const log = await readFile(join(dir, "log.txt"), "utf8").catch(() => "")
  const line = log.split("\n").map((entry) => entry.trim()).filter((entry) => entry !== "" && !/^\s*at /.test(entry)).at(-1)
  return line ?? "the request stopped before it finished"
}

/** When each current record was last changed, from one log walk. */
async function lastTouched(git: Git, repo: string): Promise<Map<string, string>> {
  const log = await git(repo, ["-c", "core.quotePath=false", "log", "--first-parent", "--diff-merges=first-parent", "--name-only", "--format=%x1e%cI"])
  const seen = new Map<string, string>()
  for (const chunk of log.stdout.split("\x1e").slice(1)) {
    const [at = "", ...files] = chunk.split("\n").map((line) => line.trim()).filter(Boolean)
    for (const file of files) if (!seen.has(file)) seen.set(file, at)
  }
  return seen
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
