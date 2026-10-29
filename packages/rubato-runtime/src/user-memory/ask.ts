// A request from Settings > Memory about what Rubato remembers: why it remembers something, a
// correction, a narrowing, a forget, or something new to remember. A model answers in the user's
// language and makes the change in the store itself, on a worktree branch; the runner checks it and
// lands it under the writer lock, records forgets in the same lock, refreshes the summary, and writes
// what actually changed next to the request. The page shows that result, not the model's say-so.
//
//   runtime/asks/<id>/request.json   {id, text, focus?: {path, text?}, createdAt}  written by the page's server
//   runtime/asks/<id>/result.json    AskResult                                      written here

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { GitMemoryRepo, LockContentionError, createLockRecord, createNodeGitExec, withLock } from "@rubato/memory-core"

import {
  AS_DREAM,
  childArgs,
  commitsAhead,
  deleteBranch,
  failureLine,
  removeWorktree,
  spawnLogged,
  underWriterLock,
  type ChildLaunch,
  type DreamAttempt,
  type DreamRung,
  type Git,
  type SpawnChild,
} from "../dream/runner"
import { addTombstones, matchedTerms, readLedger, type Tombstone } from "./ledger"
import { listRecords, plainLine, topicOf, type UserRecord } from "./records"
import { ensureUserStore, readJsonFile, userStore, writeJsonFile, type UserStore } from "./store"
import { readSummary, type SummaryCache, type SummaryOut } from "./summary"
import { landGuarded, refreshSummary } from "./user-dream"

export const ASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CHILD_TIMEOUT_MS = 10 * 60_000
const TEXT_MAX = 4000

export interface AskRequest {
  readonly id: string
  readonly text: string
  /** The remembered line the user asked from, when they asked from one. */
  readonly focus?: { readonly path: string; readonly text?: string } | null
  readonly createdAt: string
}

export interface AskChange {
  readonly path: string
  readonly topic: string
  readonly change: "added" | "modified" | "deleted" | "renamed"
  readonly from?: string
  /** The line a person read before (summary line, else the record's conclusion). */
  readonly before?: string
  readonly after?: string
}

export interface AskResult {
  readonly id: string
  readonly status: "done" | "failed" | "busy"
  readonly reply?: string
  readonly changes: readonly AskChange[]
  readonly forgotten: readonly { readonly what: string }[]
  readonly model?: string
  readonly attempts: readonly DreamAttempt[]
  readonly startedAt: string
  readonly finishedAt: string
  readonly reason?: string
  /** Store revision after the change landed. */
  readonly revision?: string
  /**
   * The change landed, but something after it did not finish: the forget was not recorded, the summary
   * was not refreshed, what changed could not be read back, or the run stopped before replying.
   */
  readonly problems?: readonly AskProblem[]
}

export type AskProblem = "forget-unrecorded" | "summary-stale" | "changes-unread" | "reply-lost"

/** Written under the writer lock the moment a request's change lands: proof it landed if the run dies after. */
export interface AskLanded {
  readonly base: string
  readonly revision: string
  readonly at: string
}

export interface RunUserAskOptions {
  readonly memoryRoot: string
  readonly id: string
  readonly ladder: readonly DreamRung[]
  readonly launch: ChildLaunch
  readonly systemPrompt: string
  readonly env: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly spawnChild?: SpawnChild
  readonly childTimeoutMs?: number
}

export function askDir(store: UserStore, id: string): string {
  return join(store.asks, id)
}

export async function readAskRequest(store: UserStore, id: string): Promise<AskRequest | undefined> {
  if (!ASK_ID.test(id)) return undefined
  const request = await readJsonFile<AskRequest>(join(askDir(store, id), "request.json"))
  if (request === undefined || typeof request.text !== "string" || request.text.trim() === "" || request.text.length > TEXT_MAX) return undefined
  return request
}

export async function runUserAsk(options: RunUserAskOptions): Promise<AskResult> {
  const now = options.now ?? Date.now
  const store = userStore(options.memoryRoot)
  const startedAt = new Date(now()).toISOString()
  const write = async (result: AskResult): Promise<AskResult> => {
    await writeJsonFile(join(askDir(store, options.id), "result.json"), result)
    return result
  }
  const request = await readAskRequest(store, options.id)
  if (request === undefined) {
    if (!ASK_ID.test(options.id)) throw new Error(`not a request id: ${options.id}`)
    return write({ id: options.id, status: "failed", changes: [], forgotten: [], attempts: [], startedAt, finishedAt: startedAt, reason: "the request is missing or empty" })
  }
  await mkdir(store.paths.locks, { recursive: true })
  const record = await createLockRecord(`ask ${options.id} (${store.id})`)
  try {
    return await withLock(join(store.paths.locks, "user-ask.lock"), record, async () => write(await askLocked(options, store, request, startedAt, now)), { waitTimeoutMs: 0 })
  } catch (error) {
    if (!(error instanceof LockContentionError)) throw error
    return write({ id: options.id, status: "busy", changes: [], forgotten: [], attempts: [], startedAt, finishedAt: new Date(now()).toISOString(), reason: "another request about your memory is still being handled" })
  }
}

interface ForgetOut {
  readonly what?: unknown
  readonly terms?: unknown
}

async function askLocked(options: RunUserAskOptions, store: UserStore, request: AskRequest, startedAt: string, now: () => number): Promise<AskResult> {
  const done = (status: AskResult["status"], extra: Partial<AskResult>): AskResult =>
    ({ id: request.id, status, changes: [], forgotten: [], attempts: [], startedAt, finishedAt: new Date(now()).toISOString(), ...extra })
  if (options.ladder.length === 0) return done("failed", { reason: "no model configured in memory.dream.models" })
  await ensureUserStore(store)
  const runDir = join(askDir(store, request.id), "run")
  const outDir = join(runDir, "out")
  await mkdir(outDir, { recursive: true })

  const exec = createNodeGitExec()
  const git: Git = async (cwd, argv) => exec.run(argv, { cwd, timeoutMs: 60_000, env: options.env })
  const repo = new GitMemoryRepo({ dir: store.paths.repo, agentId: store.id, exec })
  await underWriterLock(store.paths, store.id, "user memory ask adopt", () => repo.adoptStrayEdits())
  const baseRevision = (await git(store.paths.repo, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim()
  const before = await listRecords(git, store.paths.repo, baseRevision)
  const summaryBefore = await readSummary(store)
  const summaryIn = join(runDir, "summary-in.json")
  await writeJsonFile(summaryIn, summaryBefore)
  const promptPath = join(runDir, "system-prompt.md")
  await writeFile(promptPath, options.systemPrompt, "utf8")
  const branch = `ask/${request.id}-${randomBytes(2).toString("hex")}`
  const worktree = join(store.paths.worktrees, `ask-${request.id}`)
  await mkdir(store.paths.worktrees, { recursive: true })

  const spawnChild = options.spawnChild ?? spawnLogged
  const attempts: DreamAttempt[] = []
  let usedModel: string | undefined
  let accepted: { reply: string; forget: Tombstone[]; summary: SummaryOut | undefined } | undefined
  for (const [index, rung] of options.ladder.entries()) {
    await removeWorktree(repo, git, worktree, branch)
    await repo.worktreeAdd(worktree, branch, baseRevision)
    await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })
    usedModel = rung.model
    const logPath = join(runDir, `child-${index + 1}.log`)
    const result = await spawnChild({
      command: options.launch.command,
      args: childArgs(options.launch, promptPath, join(runDir, "session"), rung, "Handle the user's request now."),
      cwd: worktree,
      env: {
        ...options.env,
        ...options.launch.env,
        MEMORY_DIR: worktree,
        REQUEST_PATH: join(askDir(store, request.id), "request.json"),
        FORGOTTEN_PATH: store.ledger,
        SUMMARY_IN: summaryIn,
        OBSERVATIONS_DIR: store.observations,
        OUT_DIR: outDir,
        TODAY: startedAt.slice(0, 10),
        DREAM_STORE: store.id,
      },
      logPath,
      timeoutMs: options.childTimeoutMs ?? CHILD_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      attempts.push({ model: rung.model, ok: false, error: await failureLine(logPath, result.code) })
      continue
    }
    if ((await git(worktree, ["status", "--porcelain"])).stdout.trim() !== "") {
      await git(worktree, ["add", "-A"])
      await git(worktree, [...AS_DREAM, "commit", "--no-verify", "-m", "ask: commit edits the request left uncommitted"])
    }
    const problem = await checkOutput(git, worktree, outDir, startedAt, request.id)
    if (typeof problem === "string") {
      attempts.push({ model: rung.model, ok: false, error: problem })
      continue
    }
    attempts.push({ model: rung.model, ok: true })
    accepted = problem
    break
  }
  const modelField = usedModel === undefined ? { attempts } : { model: usedModel, attempts }
  await repo.worktreeRemove(worktree, true).catch(() => undefined)
  await rm(worktree, { recursive: true, force: true })
  if (accepted === undefined) {
    await deleteBranch(git, store.paths.repo, branch)
    return done("failed", { ...modelField, reason: attempts.at(-1)?.error ?? "the request could not be handled" })
  }

  const commits = await commitsAhead(git, store.paths.repo, branch, baseRevision)
  if (commits.length === 0 && accepted.forget.length === 0) {
    await deleteBranch(git, store.paths.repo, branch)
    return done("done", { ...modelField, reply: accepted.reply, revision: baseRevision })
  }
  const forget = accepted.forget
  // What was forgotten must be gone from the store as it will be, not only from this request's copy:
  // another writer may have landed the same claim meanwhile.
  const stillIn = async (revision: string) => {
    if (forget.length === 0) return undefined
    const records = await listRecords(git, store.paths.repo, revision)
    for (const tombstone of forget) {
      const still = records.find((record) => matchedTerms(record.text, tombstone).length > 0)
      if (still !== undefined) return `the forgotten claim is still in ${still.path}`
    }
    return undefined
  }
  const produced = commits.length === 0 ? baseRevision : (await git(store.paths.repo, ["rev-parse", branch])).stdout.trim()
  let forgetUnrecorded = false
  const recordForgets = async () => {
    try {
      await addTombstones(store, forget)
    } catch {
      forgetUnrecorded = true
    }
  }
  const landed = commits.length === 0
    ? await underWriterLock(store.paths, store.id, "user memory forget", async () => {
      const problem = await stillIn("HEAD")
      if (problem !== undefined) return problem
      await addTombstones(store, forget)
      return true as const
    })
    : await landGuarded({
      store,
      git,
      repo,
      branch,
      subject: `merge(ask): ${request.id}`,
      ledgerFor: () => readLedger(store),
      // The user's own words in this request are newer than any forget: saying it again is allowed.
      newerEvidence: [{ text: request.text, at: startedAt }],
      checkMerged: stillIn,
      afterMerge: async () => {
        const head = (await git(store.paths.repo, ["rev-parse", "HEAD"])).stdout.trim()
        const marker: AskLanded = { base: baseRevision, revision: head, at: new Date(now()).toISOString() }
        await writeJsonFile(join(askDir(store, request.id), "landed.json"), marker).catch(() => undefined)
        await recordForgets()
      },
    })
  await deleteBranch(git, store.paths.repo, branch).catch(() => undefined)
  if (landed !== true) return done("failed", { ...modelField, reason: `${landed}; nothing was changed` })

  // From here the change is in the store: whatever fails after it is reported with it, never as "nothing changed".
  const problems: AskProblem[] = forgetUnrecorded ? ["forget-unrecorded"] : []
  try {
    await refreshSummary(store, git, accepted.summary, produced)
  } catch {
    problems.push("summary-stale")
  }
  let changes: AskChange[] = []
  let revision: string | undefined
  try {
    revision = (await git(store.paths.repo, ["rev-parse", "HEAD"])).stdout.trim()
    const after = await listRecords(git, store.paths.repo, revision)
    changes = describeChanges(before, after, summaryBefore, await readSummary(store).catch(() => summaryBefore))
  } catch {
    problems.push("changes-unread")
  }
  return done("done", {
    ...modelField,
    reply: accepted.reply,
    changes,
    forgotten: forget.map((entry) => ({ what: entry.what })),
    ...(revision === undefined ? {} : { revision }),
    ...(problems.length === 0 ? {} : { problems }),
  })
}

/** What the child left must hold up: a reply, and every forget named and actually gone from the store. */
async function checkOutput(git: Git, worktree: string, outDir: string, at: string, askId: string) {
  const reply = (await readFile(join(outDir, "reply.md"), "utf8").catch(() => "")).trim()
  if (reply === "") return "no reply was written"
  const out = existsSync(join(outDir, "result.json")) ? await readJsonFile<{ forget?: unknown; summary?: SummaryOut }>(join(outDir, "result.json")) : {}
  if (out === undefined) return "result.json is not JSON"
  const forget: Tombstone[] = []
  for (const entry of Array.isArray(out.forget) ? out.forget as ForgetOut[] : []) {
    const terms = Array.isArray(entry.terms) ? entry.terms.filter((term): term is string => typeof term === "string" && term.trim() !== "") : []
    if (typeof entry.what !== "string" || entry.what.trim() === "" || terms.length === 0) return "a forget did not name what was forgotten and the words that would bring it back"
    forget.push({ what: entry.what.trim(), terms, at, askId })
  }
  if (forget.length > 0) {
    const records = await listRecords(git, worktree, "HEAD")
    for (const tombstone of forget) {
      const still = records.find((record) => matchedTerms(record.text, tombstone).length > 0)
      if (still !== undefined) return `the forgotten claim is still in ${still.path}`
    }
  }
  return { reply, forget, summary: out.summary }
}

/** The change in words a person reads: the line before and after, per record. */
export function describeChanges(before: readonly UserRecord[], after: readonly UserRecord[], summaryBefore: SummaryCache, summaryAfter: SummaryCache): AskChange[] {
  const line = (record: UserRecord, summary: SummaryCache) =>
    summary.items[record.path]?.blob === record.blob ? summary.items[record.path]!.text : plainLine(record)
  const old = new Map(before.map((record) => [record.path, record]))
  const next = new Map(after.map((record) => [record.path, record]))
  const changes: AskChange[] = []
  const removed = before.filter((record) => !next.has(record.path))
  for (const record of after) {
    const previous = old.get(record.path)
    if (previous === undefined) {
      const moved = removed.find((candidate) => candidate.blob === record.blob)
      changes.push(moved === undefined
        ? { path: record.path, topic: record.topic, change: "added", after: line(record, summaryAfter) }
        : { path: record.path, topic: record.topic, change: "renamed", from: moved.path, before: line(moved, summaryBefore), after: line(record, summaryAfter) })
    } else if (previous.blob !== record.blob) {
      changes.push({ path: record.path, topic: record.topic, change: "modified", before: line(previous, summaryBefore), after: line(record, summaryAfter) })
    }
  }
  for (const record of removed) {
    if (changes.some((change) => change.from === record.path)) continue
    changes.push({ path: record.path, topic: topicOf(record.path), change: "deleted", before: line(record, summaryBefore) })
  }
  return changes
}
