// The user dream: one curator for the shared user store. Project dreams only notice things about the
// person; this run turns what they noticed (and, once, what the transition carries over) into records,
// reconciles them with what the store already says, and writes the display summary. It lands on its own
// like every dream. One at a time (the store's dream lock), so project dreams finishing together never
// edit the user store at once: whichever finds the lock busy leaves its observations for the next run.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { GitMemoryRepo, LockContentionError, createLockRecord, createNodeGitExec, withLock } from "@rubato/memory-core"

import {
  AS_DREAM,
  childArgs,
  commitsAhead,
  deleteBranch,
  dreamDir,
  dreamLockPath,
  failureLine,
  removeWorktree,
  spawnLogged,
  underWriterLock,
  type ChildLaunch,
  type DreamAttempt,
  type DreamRung,
  type DreamRunRecord,
  type DreamStatus,
  type Git,
  type SpawnChild,
} from "../dream/runner"
import { resurrections } from "./guard"
import { blockingTombstone, readLedger, type Ledger } from "./ledger"
import { collectPending, consumeInputs, hasPending, readInputsLedger, recordFailure, type Observation, type PendingInputs } from "./observations"
import { listRecords } from "./records"
import { ensureUserStore, readJsonFile, userStore, writeJsonFile, type UserStore } from "./store"
import { mergeSummary, readSummary, writeSummary, type SummaryOut } from "./summary"

const CHILD_TIMEOUT_MS = 45 * 60_000

export interface RunUserDreamOptions {
  readonly memoryRoot: string
  readonly ladder: readonly DreamRung[]
  readonly launch: ChildLaunch
  readonly systemPrompt: string
  readonly env: NodeJS.ProcessEnv
  /** Run even with nothing new (manual runs), and without waiting out a recent failure. */
  readonly force?: boolean
  /** After a failed run, wait this long before the next automatic one. */
  readonly retryGapMs?: number
  readonly now?: () => number
  readonly spawnChild?: SpawnChild
  readonly childTimeoutMs?: number
}

export interface UserDreamRecord extends DreamRunRecord {
  readonly observations?: number
  /** Observations left out because they would bring back something the user forgot. */
  readonly blocked?: number
}

export async function runUserDream(options: RunUserDreamOptions): Promise<UserDreamRecord> {
  const now = options.now ?? Date.now
  const store = userStore(options.memoryRoot)
  await mkdir(store.paths.locks, { recursive: true })
  const record = await createLockRecord(`dream (${store.id})`)
  try {
    return await withLock(dreamLockPath(store.paths), record, () => dreamLocked(options, store, now), { waitTimeoutMs: 0 })
  } catch (error) {
    if (!(error instanceof LockContentionError)) throw error
    const at = new Date(now()).toISOString()
    return { runId: "", store: store.id, startedAt: at, finishedAt: at, status: "busy", reason: "another user dream is running", sessions: [], commits: [] }
  }
}

/** Whether an automatic run would have anything to do (and is not waiting out a failure). */
export async function userDreamDue(memoryRoot: string, now: number, retryGapMs: number): Promise<boolean> {
  const store = userStore(memoryRoot)
  const ledger = await readInputsLedger(store)
  const failedAt = Date.parse(ledger.failedAt ?? "")
  if (Number.isFinite(failedAt) && now - failedAt < retryGapMs) return false
  return hasPending(await collectPending(memoryRoot, store, now))
}

async function dreamLocked(options: RunUserDreamOptions, store: UserStore, now: () => number): Promise<UserDreamRecord> {
  const startedAt = new Date(now()).toISOString()
  const quiet = (reason: string): UserDreamRecord =>
    ({ runId: "", store: store.id, startedAt, finishedAt: startedAt, status: "noop", reason, sessions: [], commits: [] })
  if (options.force !== true) {
    const failedAt = Date.parse((await readInputsLedger(store)).failedAt ?? "")
    if (Number.isFinite(failedAt) && now() - failedAt < (options.retryGapMs ?? 0)) return quiet("waiting after a failed run")
  }
  await ensureUserStore(store)
  const pending = await collectPending(options.memoryRoot, store, now())
  if (!hasPending(pending) && options.force !== true) return quiet("nothing new about the user")

  const runId = `user-dream-${startedAt.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`
  const runDir = join(dreamDir(store.paths), "runs", runId)
  const inputsDir = join(runDir, "inputs")
  const outDir = join(runDir, "out")
  await mkdir(inputsDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  const ledger = await readLedger(store)
  const kept: Observation[] = []
  let blocked = 0
  for (const observation of pending.observations) {
    if (blockingTombstone(`${observation.claim}\n${observation.quote ?? ""}`, observation.at, ledger) === undefined) kept.push(observation)
    else blocked += 1
  }
  const base = { runId, store: store.id, startedAt, sessions: [], observations: kept.length, blocked }
  const finish = async (status: DreamStatus, extra: Partial<UserDreamRecord> = {}): Promise<UserDreamRecord> => {
    const result: UserDreamRecord = { ...base, finishedAt: new Date(now()).toISOString(), status, commits: [], ...extra }
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
    if (status === "merged" || status === "noop") await consumeInputs(store, pending, { runId, status, at: result.finishedAt }, now())
    if (status === "failed") await recordFailure(store, { runId, at: result.finishedAt })
    return result
  }

  if (kept.length === 0 && pending.legacyProfile === undefined && options.force !== true) {
    return finish("noop", { reason: blocked > 0 ? "everything new was something the user forgot" : "nothing new about the user" })
  }
  if (options.ladder.length === 0) return finish("failed", { reason: "no model configured in memory.dream.models" })

  const summaryBefore = await readSummary(store)
  await writeFile(join(inputsDir, "observations.md"), renderObservations(kept), "utf8")
  await writeFile(join(inputsDir, "forgotten.md"), renderForgotten(ledger), "utf8")
  if (pending.legacyProfile !== undefined) await writeFile(join(inputsDir, "legacy-profile.md"), `${pending.legacyProfile.text}\n`, "utf8")
  const summaryIn = join(inputsDir, "summary-in.json")
  await writeJsonFile(summaryIn, summaryBefore)

  const exec = createNodeGitExec()
  const git: Git = async (cwd, argv) => exec.run(argv, { cwd, timeoutMs: 60_000, env: options.env })
  const repo = new GitMemoryRepo({ dir: store.paths.repo, agentId: store.id, exec })
  await underWriterLock(store.paths, store.id, "user dream adopt", () => repo.adoptStrayEdits())
  const baseRevision = (await git(store.paths.repo, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim()
  const branch = `dream/${runId}`
  const worktree = join(store.paths.worktrees, runId)
  await mkdir(store.paths.worktrees, { recursive: true })
  const promptPath = join(runDir, "system-prompt.md")
  await writeFile(promptPath, options.systemPrompt, "utf8")

  const spawnChild = options.spawnChild ?? spawnLogged
  const attempts: DreamAttempt[] = []
  let usedModel: string | undefined
  let childOk = false
  for (const [index, rung] of options.ladder.entries()) {
    await removeWorktree(repo, git, worktree, branch)
    await repo.worktreeAdd(worktree, branch, baseRevision)
    usedModel = rung.model
    const logPath = join(runDir, `child-${index + 1}.log`)
    const result = await spawnChild({
      command: options.launch.command,
      args: childArgs(options.launch, promptPath, join(runDir, "session"), rung, "Run the user dream now."),
      cwd: worktree,
      env: {
        ...options.env,
        ...options.launch.env,
        MEMORY_DIR: worktree,
        INPUTS_DIR: inputsDir,
        SUMMARY_IN: summaryIn,
        OUT_DIR: outDir,
        TODAY: startedAt.slice(0, 10),
        DREAM_STORE: store.id,
      },
      logPath,
      timeoutMs: options.childTimeoutMs ?? CHILD_TIMEOUT_MS,
    })
    if (result.code === 0) {
      attempts.push({ model: rung.model, ok: true })
      childOk = true
      break
    }
    attempts.push({ model: rung.model, ok: false, error: await failureLine(logPath, result.code) })
  }
  const modelField = usedModel === undefined ? { attempts } : { model: usedModel, attempts }
  if (!childOk) {
    await removeWorktree(repo, git, worktree, branch)
    return finish("failed", { ...modelField, reason: "every model in the ladder failed; see child-*.log" })
  }
  if ((await git(worktree, ["status", "--porcelain"])).stdout.trim() !== "") {
    await git(worktree, ["add", "-A"])
    await git(worktree, [...AS_DREAM, "commit", "--no-verify", "-m", "dream: commit edits the user dream left uncommitted"])
  }
  const commits = await commitsAhead(git, store.paths.repo, branch, baseRevision)
  await repo.worktreeRemove(worktree, true).catch(() => undefined)
  await rm(worktree, { recursive: true, force: true })
  if (commits.length === 0) {
    await deleteBranch(git, store.paths.repo, branch)
    // Records were right as they were; a curator may still have described them for the user.
    await refreshSummary(store, git, await readJsonFile<SummaryOut>(join(outDir, "summary.json")), baseRevision)
    return finish("noop", modelField)
  }
  if (!existsSync(join(outDir, "report.md"))) {
    await deleteBranch(git, store.paths.repo, branch)
    return finish("failed", { ...modelField, commits, reason: "the user dream committed but wrote no report; nothing published" })
  }

  const produced = (await git(store.paths.repo, ["rev-parse", branch])).stdout.trim()
  const landed = await landGuarded({ store, git, repo, branch, subject: `merge(dream): ${runId}`, ledgerFor: () => readLedger(store), newerEvidence: evidenceOf(kept) })
  await deleteBranch(git, store.paths.repo, branch)
  if (landed !== true) return finish("failed", { ...modelField, commits, baseRevision, reason: `${landed}; its observations stay for the next run` })

  await writeJsonFile(join(store.observations, `${runId}.json`), kept)
  await refreshSummary(store, git, await readJsonFile<SummaryOut>(join(outDir, "summary.json")), produced)
  return finish("merged", { ...modelField, commits, baseRevision })
}

export function evidenceOf(observations: readonly Observation[]): { text: string; at?: string }[] {
  return observations.map((entry) => ({ text: `${entry.claim}\n${entry.quote ?? ""}`, ...(entry.at === undefined ? {} : { at: entry.at }) }))
}

/**
 * Merges `branch` into the store under the writer lock, after checking it against the forget ledger as
 * it is right then; `afterMerge` runs inside the same lock (an ask records its forgets there).
 */
export async function landGuarded(input: {
  readonly store: UserStore
  readonly git: Git
  readonly repo: GitMemoryRepo
  readonly branch: string
  readonly subject: string
  readonly ledgerFor: () => Promise<Ledger>
  readonly newerEvidence: readonly { readonly text: string; readonly at?: string }[]
  /** A last word on the tree the merge would produce (an ask: what it forgot is gone from it). */
  readonly checkMerged?: (tree: string) => Promise<string | undefined>
  readonly afterMerge?: () => Promise<void>
}): Promise<true | string> {
  const { store, git, repo, branch } = input
  return underWriterLock(store.paths, store.id, "user memory merge", async () => {
    await repo.adoptStrayEdits()
    const back = await resurrections(git, store.paths.repo, branch, "HEAD", await input.ledgerFor(), input.newerEvidence)
    if (back.length > 0) {
      const first = back[0]!
      return `it would bring back something the user asked to forget (${first.path}: ${first.what})`
    }
    if (input.checkMerged !== undefined) {
      const tree = await git(store.paths.repo, ["merge-tree", "--write-tree", "HEAD", branch])
      if (tree.code !== 0) return `merge failed: ${(tree.stdout.split("\n").find((line) => line.startsWith("CONFLICT")) ?? "conflict").trim()}`
      const problem = await input.checkMerged(tree.stdout.split("\n")[0]!.trim())
      if (problem !== undefined) return problem
    }
    const merge = await git(store.paths.repo, [...AS_DREAM, "merge", "--no-ff", "-m", input.subject, branch])
    if (merge.code !== 0) {
      await git(store.paths.repo, ["merge", "--abort"])
      return `merge failed: ${(merge.stderr || merge.stdout).trim().split("\n")[0]}`
    }
    await input.afterMerge?.()
    return true
  })
}

/**
 * The display summary after a curator ran: its lines attach to the records as it left them at
 * `produced` (its branch head, or the base it read when it changed nothing), and only where the store
 * still holds those versions now.
 */
export async function refreshSummary(store: UserStore, git: Git, out: SummaryOut | undefined, produced?: string): Promise<void> {
  const blobsAt = async (revision: string) => new Map((await listRecords(git, store.paths.repo, revision)).map((record) => [record.path, record.blob]))
  const current = await blobsAt("HEAD")
  await writeSummary(store, mergeSummary(await readSummary(store), out, current, produced === undefined ? undefined : await blobsAt(produced)))
}

function renderObservations(list: readonly Observation[]): string {
  if (list.length === 0) return "# Observations\n\nNone this time.\n"
  const lines = ["# Observations", "", "What project dreams noticed about the user. `said` is the user's own words; `when` is when they said it, checked against the session (absent when the quote could not be found there).", ""]
  list.forEach((entry, index) => {
    lines.push(`## ${index + 1}`, `- claim: ${entry.claim}`)
    if (entry.quote !== undefined) lines.push(`- said: "${entry.quote}"`)
    if (entry.at !== undefined) lines.push(`- when: ${entry.at}`)
    if (entry.project !== undefined) lines.push(`- project: ${entry.project}`)
    if (entry.session !== undefined) lines.push(`- session: ${entry.session}`)
    if (entry.kind === "legacy-candidate") lines.push(`- source: a suggestion from an earlier dream, noticed ${entry.seenAt?.slice(0, 10) ?? "earlier"}; it was never approved or dismissed`)
    lines.push("")
  })
  return `${lines.join("\n")}\n`
}

function renderForgotten(ledger: Ledger): string {
  if (ledger.forgotten.length === 0) return "# Forgotten\n\nNothing.\n"
  return [
    "# Forgotten",
    "",
    "The user asked to forget these. Do not write them back in any wording or language.",
    "",
    ...ledger.forgotten.map((entry) => `- ${entry.what} (asked ${entry.at.slice(0, 10)})`),
    "",
  ].join("\n")
}

export type { PendingInputs }
