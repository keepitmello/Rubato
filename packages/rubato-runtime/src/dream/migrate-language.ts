import { randomBytes } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  GitMemoryRepo,
  LockContentionError,
  createLockRecord,
  createNodeGitExec,
  withLock,
  type MemoryIdentityPaths,
} from "@rubato/memory-core"

import {
  AS_DREAM,
  childArgs,
  commitsAhead,
  deleteBranch,
  dreamDir,
  dreamLockPath,
  failureLine,
  mergeUnderWriterLock,
  readJson,
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
} from "./runner"
import { checkBatch, type MigrationBatch } from "./verbatim-check"
import { needsTranslation } from "./verbatim"

// The one-time move of a store's records into English. Memory used to be written in the store's
// language; it is now written in English with the user's own words kept as they were. Every store
// passes here once, on its next dream after the update: same dream lock, same model ladder, a worktree
// branch that lands with one `merge(dream): <runId>` (so `rubato dream --revert` takes it back out),
// and a marker so it never runs again, reverted or not.
//
// The child only translates. The runner decides what lands: each batch must change only its own files,
// keep every symptom body, quoted span and `>` line byte for byte (verbatim.ts), drop `## 증상`, and
// leave little Korean prose. A batch that fails on every model sinks the whole run; nothing lands and
// the next dream tries again after the retry gap. Legacy `system/` files are never offered.

export const LANGUAGE_MIGRATION_ID = "english-records-1"
export const DEFAULT_MIGRATION_BATCH_CHARS = 30_000
const CHILD_TIMEOUT_MS = 45 * 60_000
const LEGACY_DIR = "system/"

export interface MigrationMarker {
  readonly status: "merged" | "noop"
  readonly runId: string
  readonly at: string
}

export interface MigrationsState {
  /** Migrations that finished, by id. Present means never again. */
  readonly done?: Readonly<Record<string, MigrationMarker>>
  /** The last failed try, by id: spaces retries. */
  readonly failed?: Readonly<Record<string, { readonly runId: string; readonly at: string; readonly reason?: string }>>
}

export function migrationsPath(paths: MemoryIdentityPaths): string {
  return join(dreamDir(paths), "migrations.json")
}

export async function readMigrations(paths: MemoryIdentityPaths): Promise<MigrationsState> {
  return (await readJson<MigrationsState>(migrationsPath(paths))) ?? {}
}

/** True until the migration has landed or found nothing to do; a recent failure waits out `retryGapMs`. */
export async function languageMigrationDue(paths: MemoryIdentityPaths, now: number, retryGapMs: number): Promise<boolean> {
  const state = await readMigrations(paths)
  if (state.done?.[LANGUAGE_MIGRATION_ID] !== undefined) return false
  const failedAt = Date.parse(state.failed?.[LANGUAGE_MIGRATION_ID]?.at ?? "")
  return !(Number.isFinite(failedAt) && now - failedAt < retryGapMs)
}

async function writeMigrations(paths: MemoryIdentityPaths, next: MigrationsState): Promise<void> {
  await mkdir(dreamDir(paths), { recursive: true })
  await writeFile(migrationsPath(paths), `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

export interface RunMigrationOptions {
  readonly store: string
  readonly paths: MemoryIdentityPaths
  readonly ladder: readonly DreamRung[]
  readonly launch: ChildLaunch
  readonly systemPrompt: string
  readonly env: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly spawnChild?: SpawnChild
  readonly batchChars?: number
  readonly childTimeoutMs?: number
  /** Runs verbatim-check.ts; defaults to this bun and the file next to this one. */
  readonly checkCommand?: readonly string[]
}

export async function runLanguageMigration(options: RunMigrationOptions): Promise<DreamRunRecord> {
  const now = options.now ?? Date.now
  await mkdir(options.paths.locks, { recursive: true })
  const record = await createLockRecord(`dream language migration (${options.store})`)
  try {
    return await withLock(dreamLockPath(options.paths), record, () => migrateLocked(options, now), { waitTimeoutMs: 0 })
  } catch (error) {
    if (!(error instanceof LockContentionError)) throw error
    const at = new Date(now()).toISOString()
    return {
      runId: "", kind: "language-migration", store: options.store, startedAt: at, finishedAt: at, status: "busy",
      reason: "another dream is running for this store", sessions: [], commits: [],
    }
  }
}

/** Groups files into batches of about `budget` characters, in path order; a big file gets its own. */
export function packBatches(files: readonly { readonly path: string; readonly size: number }[], budget: number): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let used = 0
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (current.length > 0 && used + file.size > budget) {
      batches.push(current)
      current = []
      used = 0
    }
    current.push(file.path)
    used += file.size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function migrateLocked(options: RunMigrationOptions, now: () => number): Promise<DreamRunRecord> {
  const { paths, store } = options
  const startedAt = new Date(now()).toISOString()
  const runId = `migrate-${startedAt.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`
  const runDir = join(dreamDir(paths), "runs", runId)
  const outDir = join(runDir, "out")
  const beforeDir = join(runDir, "before")
  await mkdir(outDir, { recursive: true })

  const finish = async (status: DreamStatus, extra: Partial<DreamRunRecord> = {}): Promise<DreamRunRecord> => {
    const result: DreamRunRecord = {
      runId, kind: "language-migration", store, startedAt, finishedAt: new Date(now()).toISOString(), status,
      sessions: [], commits: [], ...extra,
    }
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
    const state = await readMigrations(paths)
    if (status === "merged" || status === "noop") {
      const { [LANGUAGE_MIGRATION_ID]: _cleared, ...failed } = state.failed ?? {}
      await writeMigrations(paths, { ...state, done: { ...state.done, [LANGUAGE_MIGRATION_ID]: { status, runId, at: result.finishedAt } }, failed })
    } else if (status === "failed") {
      await writeMigrations(paths, {
        ...state,
        failed: { ...state.failed, [LANGUAGE_MIGRATION_ID]: { runId, at: result.finishedAt, ...(result.reason === undefined ? {} : { reason: result.reason }) } },
      })
    }
    return result
  }

  const exec = createNodeGitExec()
  const git: Git = async (cwd, argv) => exec.run(argv, { cwd, timeoutMs: 60_000, env: options.env })
  const repo = new GitMemoryRepo({ dir: paths.repo, agentId: store, exec })
  // The migration starts from the store as sessions left it, edits nobody committed included.
  await underWriterLock(paths, store, "dream adopt", () => repo.adoptStrayEdits())
  const head = await git(paths.repo, ["rev-parse", "--verify", "HEAD^{commit}"])
  if (head.code !== 0) return finish("noop", { reason: "the store has no records yet" })
  const baseRevision = head.stdout.trim()

  const listed = await git(paths.repo, ["ls-tree", "-r", "-z", "--name-only", baseRevision])
  const candidates: { path: string; size: number }[] = []
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    if (!path.endsWith(".md") || path.startsWith(LEGACY_DIR)) continue
    const blob = await git(paths.repo, ["cat-file", "blob", `${baseRevision}:${path}`])
    if (blob.code !== 0 || !needsTranslation(blob.stdout)) continue
    candidates.push({ path, size: blob.stdout.length })
    await mkdir(dirname(join(beforeDir, path)), { recursive: true })
    await writeFile(join(beforeDir, path), blob.stdout, "utf8")
  }
  if (candidates.length === 0) return finish("noop", { reason: "already in English" })
  if (options.ladder.length === 0) return finish("failed", { reason: "no model configured in memory.dream.models" })

  const branch = `dream/${runId}`
  const worktree = join(paths.worktrees, runId)
  await mkdir(paths.worktrees, { recursive: true })
  await removeWorktree(repo, git, worktree, branch)
  await repo.worktreeAdd(worktree, branch, baseRevision)
  const promptPath = join(runDir, "system-prompt.md")
  await writeFile(promptPath, options.systemPrompt, "utf8")
  const spawnChild = options.spawnChild ?? spawnLogged
  const checkCommand = options.checkCommand ?? [process.execPath, join(import.meta.dir, "verbatim-check.ts")]
  const batches = packBatches(candidates, options.batchChars ?? DEFAULT_MIGRATION_BATCH_CHARS)
  const attempts: DreamAttempt[] = []
  let usedModel: string | undefined

  const sink = async (reason: string): Promise<DreamRunRecord> => {
    await removeWorktree(repo, git, worktree, branch)
    return finish("failed", { ...(usedModel === undefined ? {} : { model: usedModel }), attempts, baseRevision, reason })
  }

  for (const [index, files] of batches.entries()) {
    const label = `${index + 1}/${batches.length}`
    const batch: MigrationBatch = { memoryDir: worktree, beforeDir, files }
    const batchPath = join(runDir, `batch-${index + 1}.json`)
    await writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8")
    const checkPath = join(runDir, `check-${index + 1}.sh`)
    await writeFile(checkPath, `#!/bin/sh\nexec ${[...checkCommand, batchPath].map(shellQuote).join(" ")}\n`, { mode: 0o755 })
    const batchBase = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim()
    let landed = false
    for (const [rungIndex, rung] of options.ladder.entries()) {
      // Every rung starts from the batch's base: a rung that failed leaves nothing behind.
      await resetWorktree(git, worktree, batchBase)
      const logPath = join(runDir, `child-${index + 1}-${rungIndex + 1}.log`)
      const result = await spawnChild({
        command: options.launch.command,
        args: childArgs(options.launch, promptPath, join(runDir, "session"), rung, "Translate the files listed in $MIGRATE_BATCH now."),
        cwd: worktree,
        env: { ...options.env, ...options.launch.env, MEMORY_DIR: worktree, MIGRATE_BATCH: batchPath, VERBATIM_CHECK: checkPath, DREAM_STORE: store },
        logPath,
        timeoutMs: options.childTimeoutMs ?? CHILD_TIMEOUT_MS,
      })
      if (result.code !== 0) {
        attempts.push({ model: rung.model, ok: false, error: `batch ${label}: ${await failureLine(logPath, result.code)}` })
        continue
      }
      const problems = await batchProblems(git, worktree, batchBase, batch)
      if (problems.length > 0) {
        await writeFile(join(runDir, `problems-${index + 1}-${rungIndex + 1}.txt`), `${problems.join("\n")}\n`, "utf8")
        attempts.push({ model: rung.model, ok: false, error: `batch ${label}: ${problems.length} problem(s), first: ${problems[0]}` })
        continue
      }
      await git(worktree, [...AS_DREAM, "commit", "-q", "--allow-empty", "-m", `dream: translate ${files.length} record(s) into English (batch ${label})`])
      attempts.push({ model: rung.model, ok: true })
      usedModel = rung.model
      landed = true
      break
    }
    if (!landed) return sink(`batch ${label} failed on every model; see problems-*.txt and child-*.log`)
  }

  // The whole branch once more against the base: only offered files, all still passing.
  const finalProblems = await batchProblems(git, worktree, baseRevision, { memoryDir: worktree, beforeDir, files: candidates.map((file) => file.path) })
  if (finalProblems.length > 0) {
    await writeFile(join(runDir, "problems-final.txt"), `${finalProblems.join("\n")}\n`, "utf8")
    return sink(`the combined result failed the check: ${finalProblems[0]}`)
  }
  await repo.worktreeRemove(worktree, true).catch(() => undefined)
  await rm(worktree, { recursive: true, force: true })
  const commits = await commitsAhead(git, paths.repo, branch, baseRevision)
  await writeFile(join(outDir, "report.md"), migrationReport(candidates.map((file) => file.path)), "utf8")

  const merged = await mergeUnderWriterLock(paths, store, git, branch, runId)
  await deleteBranch(git, paths.repo, branch)
  const modelField = usedModel === undefined ? { attempts } : { model: usedModel, attempts }
  if (merged !== true) return finish("failed", { ...modelField, commits, baseRevision, reason: merged })
  return finish("merged", { ...modelField, commits, baseRevision })
}

/** Stages the batch's work and lists what is wrong with it: files outside the batch, or files that fail the check. */
async function batchProblems(git: Git, worktree: string, from: string, batch: MigrationBatch): Promise<string[]> {
  await git(worktree, ["add", "-A"])
  const changed = await git(worktree, ["diff", "--cached", "--no-renames", "--name-status", "-z", from])
  const fields = changed.stdout.split("\0").filter(Boolean)
  const allowed = new Set(batch.files)
  const problems: string[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [status, path] = [fields[index]!, fields[index + 1]!]
    if (status !== "M" || !allowed.has(path)) problems.push(`${path}: ${status === "M" ? "changed outside the batch" : `not allowed (${status}); translate in place only`}`)
  }
  for (const [file, list] of checkBatch(batch)) for (const problem of list) problems.push(`${file}: ${problem}`)
  return problems
}

/** Back to `revision`, nothing staged, nothing untracked. Plumbing only: host git wrappers block porcelain reset. */
async function resetWorktree(git: Git, worktree: string, revision: string): Promise<void> {
  await git(worktree, ["update-ref", "HEAD", revision])
  await git(worktree, ["read-tree", "-u", "--reset", "HEAD"])
  const untracked = await git(worktree, ["ls-files", "--others", "-z"])
  for (const path of untracked.stdout.split("\0").filter(Boolean)) await rm(join(worktree, path), { force: true, recursive: true })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The report the memory page shows: written by the runner, not the model, so it says only what was checked. */
export function migrationReport(files: readonly string[]): string {
  return [
    "## Summary",
    `Translated ${files.length} record(s) into English, once, because memory is now written in English. The user's own words (symptom text, quoted requests and \`>\` quotes) are unchanged; the runner checked each file before landing.`,
    "## Changed",
    ...files.map((file) => `- \`${file}\`: rewritten — translated into English; user text kept as it was`),
    "",
  ].join("\n")
}
