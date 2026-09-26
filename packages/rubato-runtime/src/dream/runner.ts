import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  GitMemoryRepo,
  LockContentionError,
  createLockRecord,
  createNodeGitExec,
  memoryWriterLockPath,
  withLock,
  type MemoryIdentityPaths,
} from "@rubato/memory-core"
import { launchProductModel } from "@rubato/model-core"

import { condenseSession, type CondensedSession } from "./transcript"
import type { SessionFile } from "./stores"

// One dream = one store. The child edits a worktree branch so the working agent can keep writing to
// the store meanwhile. What happens to the branch is the publish policy: under "review" it waits for
// the user (`rubato dream --approve`), under "auto" it lands with one merge under the writer lock the
// memory tool takes. Memory that is wrong costs more than memory that is missing, so a failed child
// never publishes, even when it committed something.

export const DEFAULT_TRANSCRIPT_BUDGET_CHARS = 250_000
// A 12-session backlog on DeepSeek ran past 20 minutes mid-edit; a killed rung publishes nothing.
const CHILD_TIMEOUT_MS = 45 * 60_000
const FIRST_DREAM_LOOKBACK_MS = 7 * 24 * 60 * 60_000
const CURSOR_RETENTION_MS = 30 * 24 * 60 * 60_000
// Commits the runner itself makes (merge, leftovers) are signed as the dream, whatever the store's config says.
const AS_DREAM = ["-c", "user.name=dream", "-c", "user.email=dream@rubato.local"] as const

export type DreamPublish = "review" | "auto"

export interface DreamRung {
  readonly model: string
  readonly thinking?: string
}

export interface ChildLaunch {
  readonly command: string
  readonly prefixArgs: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export interface ChildResult {
  readonly code: number | null
}

export type SpawnChild = (input: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly logPath: string
  readonly timeoutMs: number
}) => Promise<ChildResult>

export type DreamStatus = "merged" | "pending" | "noop" | "failed" | "busy" | "trial"

export interface DreamRunRecord {
  readonly runId: string
  readonly store: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly status: DreamStatus
  readonly reason?: string
  readonly model?: string
  readonly sessions: readonly { readonly id: string; readonly name?: string; readonly cwd: string; readonly messages: number }[]
  readonly commits: readonly string[]
  /** Branch holding the result while it waits for review, or a trial's result. */
  readonly branch?: string
  /** Store revision the dream started from. */
  readonly baseRevision?: string
}

export interface DreamState {
  /** When the last dream took its input; spaces dreams and is the read floor for sessions with no cursor. */
  readonly last_dream_at?: string
  readonly lastRunId?: string
  /** Per session: the newest message already read. A session left out for budget keeps its old cursor. */
  readonly cursors?: Readonly<Record<string, string>>
}

export interface PendingReview {
  readonly runId: string
  readonly branch: string
  readonly baseRevision: string
  readonly reason?: string
}

export interface RunDreamOptions {
  readonly store: string
  readonly paths: MemoryIdentityPaths
  readonly sessions: readonly SessionFile[]
  readonly ladder: readonly DreamRung[]
  readonly launch: ChildLaunch
  readonly systemPrompt: string
  readonly env: NodeJS.ProcessEnv
  readonly publish?: DreamPublish
  /** Folders the store's sessions ran in; their git repositories are what claims are checked against. */
  readonly projectFolders?: readonly string[]
  /** Run the resolve pass even when no session is new (manual runs). */
  readonly force?: boolean
  /**
   * Trial run: start from `baseRevision` (default HEAD) and read from `sinceMs` (default the cursors),
   * keep the result on its branch, and touch neither the store nor its cursors.
   */
  readonly trial?: { readonly baseRevision?: string; readonly sinceMs?: number }
  readonly now?: () => number
  readonly spawnChild?: SpawnChild
  readonly transcriptBudgetChars?: number
  readonly childTimeoutMs?: number
}

export function dreamDir(paths: MemoryIdentityPaths): string {
  return join(paths.runtime, "dream")
}

export async function readDreamState(paths: MemoryIdentityPaths): Promise<DreamState> {
  return (await readJson<DreamState>(join(dreamDir(paths), "state.json"))) ?? {}
}

export async function readPendingReview(paths: MemoryIdentityPaths): Promise<PendingReview | undefined> {
  return readJson<PendingReview>(join(dreamDir(paths), "pending.json"))
}

/** Read floor for a session: its own cursor, else the last dream, else a week back. */
export function sessionSinceMs(state: DreamState, sessionId: string, now: number): number {
  const cursor = parseTime(state.cursors?.[sessionId])
  if (cursor !== undefined) return cursor
  return parseTime(state.last_dream_at) ?? now - FIRST_DREAM_LOOKBACK_MS
}

export async function runDream(options: RunDreamOptions): Promise<DreamRunRecord> {
  const now = options.now ?? Date.now
  await mkdir(options.paths.locks, { recursive: true })
  const record = await createLockRecord(`dream (${options.store})`)
  try {
    return await withLock(dreamLockPath(options.paths), record, () => runLocked(options, now), { waitTimeoutMs: 0 })
  } catch (error) {
    if (!(error instanceof LockContentionError)) throw error
    const at = new Date(now()).toISOString()
    return {
      runId: "", store: options.store, startedAt: at, finishedAt: at, status: "busy",
      reason: "another dream is running for this store", sessions: [], commits: [],
    }
  }
}

async function runLocked(options: RunDreamOptions, now: () => number): Promise<DreamRunRecord> {
  const startedAt = new Date(now()).toISOString()
  const runId = `dream-${startedAt.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`
  const runDir = join(dreamDir(options.paths), "runs", runId)
  const transcriptsDir = join(runDir, "transcripts")
  const outDir = join(runDir, "out")
  await mkdir(transcriptsDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  const state = await readDreamState(options.paths)
  const trialSince = options.trial?.sinceMs
  const sinceOf = (id: string) => trialSince ?? sessionSinceMs(state, id, now())
  const picked = pickSessions(options.sessions, sinceOf, options.transcriptBudgetChars ?? DEFAULT_TRANSCRIPT_BUDGET_CHARS)
  await Promise.all(picked.map((session, index) =>
    writeFile(join(transcriptsDir, `${String(index + 1).padStart(2, "0")}-${session.header.id}.md`), session.markdown, "utf8")))
  const oldestRead = Math.min(now(), ...options.sessions.map((session) => sinceOf(session.id)))

  const base = {
    runId,
    store: options.store,
    startedAt,
    sessions: picked.map((session) => ({
      id: session.header.id,
      ...(session.name === undefined ? {} : { name: session.name }),
      cwd: session.header.cwd,
      messages: session.messages,
    })),
  }
  // The input was consumed: move each read session's cursor to what it read. Sessions left out for
  // budget keep an explicit cursor so a later floor cannot skip their unread start.
  // The floor is the start, not the end: a session that began while the child ran was not read.
  const consume = async () => {
    const cursors: Record<string, string> = {}
    const floor = now() - CURSOR_RETENTION_MS
    for (const [id, at] of Object.entries(state.cursors ?? {})) {
      if ((parseTime(at) ?? 0) >= floor) cursors[id] = at
    }
    for (const session of options.sessions) cursors[session.id] ??= new Date(sinceOf(session.id)).toISOString()
    for (const session of picked) if (session.lastAt !== undefined) cursors[session.header.id] = session.lastAt
    const next: DreamState = { last_dream_at: startedAt, lastRunId: runId, cursors }
    await writeFile(join(dreamDir(options.paths), "state.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8")
  }
  const finish = async (status: DreamStatus, extra: Partial<DreamRunRecord> = {}): Promise<DreamRunRecord> => {
    const result: DreamRunRecord = { ...base, finishedAt: new Date(now()).toISOString(), status, commits: [], ...extra }
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
    if (status === "merged" || status === "pending" || status === "noop") await consume()
    return result
  }

  if (options.trial === undefined && (await readPendingReview(options.paths)) !== undefined) {
    return finish("failed", { reason: "a previous dream is waiting for review; approve or reject it first" })
  }
  if (picked.length === 0 && options.force !== true) return finish("noop", { reason: "no new sessions" })
  if (options.ladder.length === 0) return finish("failed", { reason: "no model configured for the dream category" })

  const exec = createNodeGitExec()
  const git: Git = async (cwd, argv) => exec.run(argv, { cwd, timeoutMs: 60_000, env: options.env })
  const repo = new GitMemoryRepo({ dir: options.paths.repo, agentId: options.store, exec })
  const baseResolved = await git(options.paths.repo, ["rev-parse", "--verify", `${options.trial?.baseRevision ?? "HEAD"}^{commit}`])
  if (baseResolved.code !== 0) return finish("failed", { reason: "store has no commits" })
  const baseRevision = baseResolved.stdout.trim()

  const branch = `dream/${runId}`
  const worktree = join(options.paths.worktrees, runId)
  await mkdir(options.paths.worktrees, { recursive: true })
  const promptPath = join(runDir, "system-prompt.md")
  await writeFile(promptPath, options.systemPrompt, "utf8")
  const projectDirs = await projectRepositories(git, options.projectFolders ?? [])
  const changesPath = join(runDir, "changes.md")
  await writeFile(changesPath, await describeChanges(git, projectDirs, oldestRead), "utf8")

  const spawnChild = options.spawnChild ?? spawnLogged
  let usedModel: string | undefined
  let childOk = false
  // A trial must not see what landed after its base: a worktree shares the store's refs, and a child
  // that finds the answer already on main writes nothing, so the comparison measures nothing. It gets
  // a clone holding only the base history instead, and its result is fetched back onto a branch.
  const prepare = options.trial === undefined
    ? async () => {
      await removeWorktree(repo, git, worktree, branch)
      await repo.worktreeAdd(worktree, branch, baseRevision)
    }
    : async () => {
      await rm(worktree, { recursive: true, force: true })
      await git(options.paths.worktrees, ["init", "-q", "-b", "trial", worktree])
      // Plumbing only: host git wrappers block porcelain `reset`/`checkout`, and a blocked step here
      // hands the child an empty tree.
      for (const argv of [
        ["fetch", "-q", "--no-tags", options.paths.repo, baseRevision],
        ["update-ref", "refs/heads/trial", "FETCH_HEAD"],
        ["read-tree", "-u", "--reset", "HEAD"],
      ]) {
        const step = await git(worktree, argv)
        if (step.code !== 0) throw new Error(`trial clone failed at git ${argv[0]}: ${(step.stderr || step.stdout).trim()}`)
      }
    }
  for (const [index, rung] of options.ladder.entries()) {
    // Every rung starts from a clean branch at the same base: a rung that died leaves nothing behind.
    await prepare()
    usedModel = rung.model
    const args = [
      ...options.launch.prefixArgs,
      "-p",
      "--system-prompt", promptPath,
      "--tools", "read,bash,edit,write",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--session-dir", join(runDir, "session"),
      "--model", launchProductModel(rung.model),
      ...(rung.thinking === undefined ? [] : ["--thinking", rung.thinking]),
      "Run the dream now.",
    ]
    const result = await spawnChild({
      command: options.launch.command,
      args,
      cwd: worktree,
      env: {
        ...options.env,
        ...options.launch.env,
        MEMORY_DIR: worktree,
        TRANSCRIPTS_DIR: transcriptsDir,
        OUT_DIR: outDir,
        CHANGES_PATH: changesPath,
        PROJECT_DIRS: projectDirs.join(":"),
        DREAM_STORE: options.store,
      },
      logPath: join(runDir, `child-${index + 1}.log`),
      timeoutMs: options.childTimeoutMs ?? CHILD_TIMEOUT_MS,
    })
    if (result.code === 0) {
      childOk = true
      break
    }
  }
  const modelField = usedModel === undefined ? {} : { model: usedModel }
  if (options.trial !== undefined) {
    if (childOk && (await git(worktree, ["status", "--porcelain"])).stdout.trim() !== "") {
      await git(worktree, ["add", "-A"])
      await git(worktree, [...AS_DREAM, "commit", "-m", "dream: commit edits the dream left uncommitted"])
    }
    await git(options.paths.repo, ["fetch", "-q", worktree, `trial:refs/heads/${branch}`])
    await rm(worktree, { recursive: true, force: true })
    const commits = await commitsAhead(git, options.paths.repo, branch, baseRevision)
    return finish(childOk ? "trial" : "failed", { ...modelField, commits, branch, baseRevision })
  }
  if (!childOk) {
    await removeWorktree(repo, git, worktree, branch)
    return finish("failed", { ...modelField, reason: "every model in the ladder failed; see child-*.log" })
  }
  if ((await git(worktree, ["status", "--porcelain"])).stdout.trim() !== "") {
    await git(worktree, ["add", "-A"])
    await git(worktree, [...AS_DREAM, "commit", "-m", "dream: commit edits the dream left uncommitted"])
  }
  const commits = await commitsAhead(git, options.paths.repo, branch, baseRevision)
  await repo.worktreeRemove(worktree, true).catch(() => undefined)
  await rm(worktree, { recursive: true, force: true })

  if (commits.length === 0) {
    await deleteBranch(git, options.paths.repo, branch)
    return finish("noop", modelField)
  }
  if (!existsSync(join(outDir, "report.md"))) {
    await deleteBranch(git, options.paths.repo, branch)
    return finish("failed", { ...modelField, commits, reason: "the dream committed but wrote no report; nothing published" })
  }

  const pending: PendingReview = { runId, branch, baseRevision }
  if ((options.publish ?? "review") === "review") {
    await writePending(options.paths, pending)
    return finish("pending", { ...modelField, commits, branch, baseRevision })
  }
  const merged = await mergeUnderWriterLock(options.paths, options.store, git, branch, runId)
  if (merged !== true) {
    await writePending(options.paths, { ...pending, reason: merged })
    return finish("pending", { ...modelField, commits, branch, baseRevision, reason: `${merged}; left for review` })
  }
  await deleteBranch(git, options.paths.repo, branch)
  return finish("merged", { ...modelField, commits, baseRevision })
}

/** Land the dream waiting for review. */
export async function approveDream(paths: MemoryIdentityPaths, store: string, env: NodeJS.ProcessEnv): Promise<string> {
  const pending = await readPendingReview(paths)
  if (pending === undefined) throw new Error(`no dream is waiting for review in ${store}`)
  const exec = createNodeGitExec()
  const git: Git = async (cwd, argv) => exec.run(argv, { cwd, timeoutMs: 60_000, env })
  const merged = await mergeUnderWriterLock(paths, store, git, pending.branch, pending.runId)
  if (merged !== true) throw new Error(`${merged}; the branch ${pending.branch} is still waiting`)
  await deleteBranch(git, paths.repo, pending.branch)
  await rm(join(dreamDir(paths), "pending.json"), { force: true })
  await recordReview(paths, pending.runId, "merged")
  return pending.runId
}

/** Drop the dream waiting for review. What it read stays read; its edits are discarded. */
export async function rejectDream(paths: MemoryIdentityPaths, store: string, env: NodeJS.ProcessEnv): Promise<string> {
  const pending = await readPendingReview(paths)
  if (pending === undefined) throw new Error(`no dream is waiting for review in ${store}`)
  const exec = createNodeGitExec()
  await deleteBranch(async (cwd, argv) => exec.run(argv, { cwd, timeoutMs: 60_000, env }), paths.repo, pending.branch)
  await rm(join(dreamDir(paths), "pending.json"), { force: true })
  await recordReview(paths, pending.runId, "rejected")
  return pending.runId
}

type Git = (cwd: string, argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>

function dreamLockPath(paths: MemoryIdentityPaths): string {
  return join(paths.locks, "dream.lock")
}

async function writePending(paths: MemoryIdentityPaths, pending: PendingReview): Promise<void> {
  await writeFile(join(dreamDir(paths), "pending.json"), `${JSON.stringify(pending, null, 2)}\n`, "utf8")
}

async function recordReview(paths: MemoryIdentityPaths, runId: string, review: "merged" | "rejected"): Promise<void> {
  const path = join(dreamDir(paths), "runs", runId, "run.json")
  const run = await readJson<Record<string, unknown>>(path)
  if (run === undefined) return
  await writeFile(path, `${JSON.stringify({ ...run, review, reviewedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
}

async function commitsAhead(git: Git, repoDir: string, branch: string, base: string): Promise<string[]> {
  const result = await git(repoDir, ["rev-list", "--reverse", `${base}..${branch}`])
  return result.code === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : []
}

async function mergeUnderWriterLock(
  paths: MemoryIdentityPaths,
  store: string,
  git: Git,
  branch: string,
  runId: string,
): Promise<true | string> {
  const record = await createLockRecord(`dream merge (${store})`)
  return withLock(memoryWriterLockPath(paths.locks), record, async () => {
    const dirty = await git(paths.repo, ["status", "--porcelain"])
    if (dirty.stdout.trim() !== "") return "store has uncommitted changes"
    const merge = await git(paths.repo, [...AS_DREAM, "merge", "--no-ff", "-m", `merge(dream): ${runId}`, branch])
    if (merge.code === 0) return true
    await git(paths.repo, ["merge", "--abort"])
    return `merge failed: ${(merge.stderr || merge.stdout).trim().split("\n")[0]}`
  }, { waitTimeoutMs: 60_000 })
}

async function removeWorktree(repo: GitMemoryRepo, git: Git, worktree: string, branch: string): Promise<void> {
  if (existsSync(worktree)) await repo.worktreeRemove(worktree, true).catch(() => undefined)
  await rm(worktree, { recursive: true, force: true })
  await git(repo.dir, ["worktree", "prune"])
  await deleteBranch(git, repo.dir, branch)
}

// Plumbing, not `branch -D`: porcelain -D is blocked by some host git wrappers.
async function deleteBranch(git: Git, repoDir: string, branch: string): Promise<void> {
  await git(repoDir, ["update-ref", "-d", `refs/heads/${branch}`])
}

async function projectRepositories(git: Git, folders: readonly string[]): Promise<string[]> {
  const roots = new Set<string>()
  for (const folder of folders) {
    if (!existsSync(folder)) continue
    const top = await git(folder, ["rev-parse", "--show-toplevel"])
    if (top.code === 0 && top.stdout.trim() !== "") roots.add(top.stdout.trim())
  }
  return [...roots].sort()
}

const CHANGES_MAX_LINES_PER_REPO = 400

/** Commits since the oldest unread point with the files they touched: the dream's stale-claim detector. */
async function describeChanges(git: Git, repos: readonly string[], sinceMs: number): Promise<string> {
  const sections: string[] = ["# Changes since the last dream\n"]
  for (const repo of repos) {
    const log = await git(repo, [
      "log", "--no-merges", `--since=${new Date(sinceMs).toISOString()}`,
      "--date=short", "--format=%n%h %ad %s", "--name-status",
    ])
    const lines = log.code === 0 ? log.stdout.trim().split("\n") : []
    const clipped = lines.length > CHANGES_MAX_LINES_PER_REPO
      ? [...lines.slice(0, CHANGES_MAX_LINES_PER_REPO), `… ${lines.length - CHANGES_MAX_LINES_PER_REPO} more lines; run git log in the repository for the rest`]
      : lines
    sections.push(`## ${repo}\n\n${clipped.join("\n").trim() || "(no commits)"}\n`)
  }
  return sections.join("\n")
}

/** Oldest activity first, until the budget: the rest keep their cursors for the next dream. */
export function pickSessions(
  sessions: readonly SessionFile[],
  sinceMs: (sessionId: string) => number,
  budgetChars: number,
): CondensedSession[] {
  const condensed = sessions
    .map((session) => condenseSession(session.path, sinceMs(session.id)))
    .filter((session): session is CondensedSession => session !== undefined && session.messages > 0)
    .sort((a, b) => (a.lastAt ?? "").localeCompare(b.lastAt ?? ""))
  const picked: CondensedSession[] = []
  let used = 0
  for (const session of condensed) {
    if (picked.length > 0 && used + session.markdown.length > budgetChars) break
    picked.push(session)
    used += session.markdown.length
  }
  return picked
}

const spawnLogged: SpawnChild = ({ command, args, cwd, env, logPath, timeoutMs }) =>
  new Promise((resolve) => {
    const log = createWriteStream(logPath)
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.on("error", (error) => {
      log.write(`\nspawn error: ${String(error)}\n`)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      log.end()
      resolve({ code })
    })
  })

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return parsed !== null && typeof parsed === "object" ? parsed as T : undefined
  } catch {
    return undefined
  }
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
