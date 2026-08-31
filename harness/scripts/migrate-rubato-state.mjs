#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

function sameFile(left, right) {
  const a = readFileSync(left)
  const b = readFileSync(right)
  return a.length === b.length && a.equals(b)
}

function pathExists(path) {
  return lstatOrNull(path) !== undefined
}

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

function ignoreGone(operation) {
  try {
    operation()
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function migratedName(name) {
  if (name === "omo.json" || name.startsWith("omo.json.")) return name.replace(/^omo\.json/, "rubato.json")
  if (name === "omo.jsonc" || name.startsWith("omo.jsonc.")) return name.replace(/^omo\.jsonc/, "rubato.jsonc")
  return name
}

function atomicWrite(path, contents) {
  const temporary = `${path}.migration-${process.pid}`
  writeFileSync(temporary, contents)
  renameSync(temporary, path)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function entryKey(entry) {
  return typeof entry?.source_line_id === "string" && entry.source_line_id.length > 0
    ? `line:${entry.source_line_id}`
    : `raw:${JSON.stringify(entry)}`
}

function mergeTranscript(source, target) {
  const legacy = readFileSync(source, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const canonical = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const merged = [...canonical]
  const present = new Set(merged.map(entryKey))
  let pending = []
  for (const entry of legacy) {
    const key = entryKey(entry)
    if (!present.has(key)) {
      pending.push(entry)
      present.add(key)
      continue
    }
    const existing = merged.findIndex((candidate) => entryKey(candidate) === key)
    if (
      existing >= 0
      && typeof entry.captured_at === "string"
      && typeof merged[existing]?.captured_at === "string"
      && entry.captured_at < merged[existing].captured_at
    ) {
      merged[existing] = entry
    }
    if (pending.length === 0) continue
    const anchor = existing
    if (anchor >= 0) merged.splice(anchor, 0, ...pending)
    else merged.push(...pending)
    pending = []
  }
  merged.push(...pending)
  atomicWrite(target, `${merged.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
  unlinkSync(source)
}

function mergeReflectionState(source, target, result) {
  const legacy = readJson(source)
  const canonical = readJson(target)
  result.stateCandidates.push({ target, states: [legacy, canonical] })
  const legacySteps = Number.isFinite(legacy.total_completed_steps) ? legacy.total_completed_steps : 0
  const canonicalSteps = Number.isFinite(canonical.total_completed_steps) ? canonical.total_completed_steps : 0
  const selected = legacySteps > canonicalSteps ? legacy : canonical
  atomicWrite(target, `${JSON.stringify(selected, null, 2)}\n`)
  unlinkSync(source)
}

function mergeFactsCursor(source, target, result) {
  const legacy = readJson(source)
  const canonical = readJson(target)
  result.factCandidates.push({ target, cursors: [legacy, canonical] })
  const legacyLine = Number.isFinite(legacy.enqueued_through_snapshot_line)
    ? legacy.enqueued_through_snapshot_line
    : -1
  const canonicalLine = Number.isFinite(canonical.enqueued_through_snapshot_line)
    ? canonical.enqueued_through_snapshot_line
    : -1
  atomicWrite(target, `${JSON.stringify(legacyLine > canonicalLine ? legacy : canonical, null, 2)}\n`)
  unlinkSync(source)
}

const migrationGitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Rubato Migration",
  GIT_AUTHOR_EMAIL: "rubato-migration@local",
  GIT_COMMITTER_NAME: "Rubato Migration",
  GIT_COMMITTER_EMAIL: "rubato-migration@local",
}

function git(repo, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding,
    env: migrationGitEnv,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git -C ${repo} ${args.join(" ")} failed: ${String(result.stderr).trim()}`)
  }
  return result
}

function gitHead(repo) {
  const result = git(repo, ["rev-parse", "HEAD"], { allowFailure: true })
  if (result.status !== 0) return ""
  const sha = result.stdout.trim()
  const object = git(repo, ["cat-file", "-e", `${sha}^{commit}`], { allowFailure: true })
  return object.status === 0 ? sha : ""
}

function commitDirtyGitTree(repo, message) {
  if (git(repo, ["status", "--porcelain"]).stdout.trim() === "") return
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-m", message])
}

function captureLegacyWorktrees(source, target) {
  const listed = git(source, ["worktree", "list", "--porcelain"], { allowFailure: true })
  if (listed.status !== 0) return []
  const worktrees = []
  let current
  for (const line of `${listed.stdout}\n`.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { sourcePath: line.slice("worktree ".length) }
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch refs/heads/".length)
    } else if (line === "" && current) {
      if (
        current.branch
        && pathExists(current.sourcePath)
        && realpathSync(current.sourcePath) !== realpathSync(source)
      ) {
        commitDirtyGitTree(
          current.sourcePath,
          "chore(memory): capture legacy worktree for Rubato migration",
        )
        worktrees.push({
          sourcePath: current.sourcePath,
          targetPath: join(dirname(target), "runtime", "worktrees", basename(current.sourcePath)),
          targetRepo: target,
          targetBranch: `rubato-migration/omo/${current.branch}`,
        })
      }
      current = undefined
    }
  }
  return worktrees
}

function legacyHead(source, target, result) {
  let sourceHead = gitHead(source)
  if (sourceHead) {
    commitDirtyGitTree(source, "chore(memory): capture legacy state for Rubato migration")
    const worktrees = captureLegacyWorktrees(source, target)
    sourceHead = gitHead(source)
    git(target, [
      "fetch",
      "--no-tags",
      source,
      "HEAD",
      "+refs/heads/*:refs/heads/rubato-migration/omo/*",
    ])
    for (const worktree of worktrees) {
      git(source, ["worktree", "remove", "--force", worktree.sourcePath])
      result.worktreeCandidates.push(worktree)
    }
    return sourceHead
  }
  const archivedRef = join(source, ".git", "refs", "heads", "main")
  if (!pathExists(archivedRef)) return ""
  const sha = readFileSync(archivedRef, "utf8").trim()
  const object = git(target, ["cat-file", "-t", sha], { allowFailure: true })
  return object.status === 0 && object.stdout.trim() === "commit" ? sha : ""
}

function removeIdenticalUntrackedLegacyFiles(target, sha) {
  const tree = git(target, ["ls-tree", "-rz", "--name-only", sha], { encoding: null }).stdout
    .toString("utf8").split("\0").filter(Boolean)
  const untracked = new Set(
    git(target, ["ls-files", "-z", "--others", "--exclude-standard"], { encoding: null }).stdout
      .toString("utf8").split("\0").filter(Boolean),
  )
  const conflicting = []
  for (const path of tree) {
    if (!untracked.has(path)) continue
    const live = join(target, path)
    const committed = git(target, ["show", `${sha}:${path}`], { allowFailure: true, encoding: null })
    if (committed.status !== 0 || !pathExists(live)) continue
    const current = readFileSync(live)
    if (current.length === committed.stdout.length && current.equals(committed.stdout)) rmSync(live)
    else conflicting.push(path)
  }
  if (conflicting.length > 0) {
    git(target, ["add", "--", ...conflicting])
    git(target, ["commit", "-m", "chore(memory): capture canonical state before OMO migration"])
  }
}

function mergeGitRepository(source, target, result) {
  const sha = legacyHead(source, target, result)
  if (!sha) return false
  removeIdenticalUntrackedLegacyFiles(target, sha)
  commitDirtyGitTree(target, "chore(memory): capture canonical state before OMO migration")
  const alreadyMerged = git(target, ["merge-base", "--is-ancestor", sha, "HEAD"], { allowFailure: true }).status === 0
  if (!alreadyMerged) {
    git(target, ["merge", "--allow-unrelated-histories", "--no-edit", "-X", "ours", sha])
  }
  rmSync(source, { recursive: true, force: true })
  result.repositories += 1
  return true
}

function isEphemeral(relative) {
  return (
    /^codegraph\/(?:worker|zombie)-sweep\.stamp$/.test(relative)
    || /^lsp-daemon\/[^/]+\/daemon\.(?:auth|log)$/.test(relative)
    || /^memory\/agents\/[^/]+\/runtime\/notices\//.test(relative)
  )
}

function resolveConflict(source, target, relative, result) {
  if (isEphemeral(relative)) {
    rmSync(source, { recursive: true, force: true })
  } else if (/\/runtime\/transcripts\/[^/]+\/transcript\.jsonl$/.test(relative)) {
    mergeTranscript(source, target)
  } else if (/\/runtime\/transcripts\/[^/]+\/state\.json$/.test(relative)) {
    mergeReflectionState(source, target, result)
  } else if (/\/runtime\/facts-queue\/cursor\/[^/]+\.json$/.test(relative)) {
    mergeFactsCursor(source, target, result)
  } else if (lstatSync(source).isSymbolicLink()) {
    unlinkSync(source)
  } else {
    rmSync(source, { recursive: true, force: true })
  }
  result.resolved += 1
}

function mergeEntry(source, target, relative, result) {
  const sourceStat = lstatOrNull(source)
  if (!sourceStat) return
  let targetStat = lstatOrNull(target)

  // 끊어진 새 경로 링크는 옛 실데이터가 대체한다. 링크 자체는 런타임 상태가 아니다.
  if (targetStat?.isSymbolicLink() && !existsSync(target)) {
    unlinkSync(target)
    targetStat = lstatOrNull(target)
  }

  // 링크도 파일 자체를 옮긴다. 가리키는 바깥 내용은 읽거나 복사하지 않는다.
  if (!targetStat) {
    mkdirSync(dirname(target), { recursive: true })
    try {
      renameSync(source, target)
      result.moved += 1
    } catch (error) {
      if (error?.code === "ENOENT") return
      if (error?.code === "EEXIST") {
        mergeEntry(source, target, relative, result)
        return
      }
      throw error
    }
    return
  }

  if (sourceStat.isSymbolicLink()) {
    resolveConflict(source, target, relative, result)
    return
  }
  if (sourceStat.isDirectory() && targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
    if (
      relative.endsWith("/repo")
      && pathExists(join(target, ".git"))
      && (pathExists(join(source, ".git")) || pathExists(join(source, ".git", "refs", "heads", "main")))
      && mergeGitRepository(source, target, result)
    ) return
    for (const name of readdirSync(source)) {
      mergeEntry(
        join(source, name),
        join(target, migratedName(name)),
        relative ? `${relative}/${migratedName(name)}` : migratedName(name),
        result,
      )
    }
    try {
      if (readdirSync(source).length === 0) rmdirSync(source)
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error
    }
    return
  }
  if (sourceStat.isFile() && targetStat.isFile() && sameFile(source, target)) {
    if (ignoreGone(() => unlinkSync(source))) result.deduplicated += 1
    return
  }
  resolveConflict(source, target, relative, result)
}

export function migrateRoot(source, target) {
  const result = {
    source,
    target,
    moved: 0,
    deduplicated: 0,
    resolved: 0,
    repositories: 0,
    stateCandidates: [],
    factCandidates: [],
    worktreeCandidates: [],
  }
  if (!pathExists(source)) return result
  if (!pathExists(target)) {
    if (lstatSync(source).isSymbolicLink()) {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(source, target)
      result.moved += 1
      return result
    }
    mkdirSync(target, { recursive: true })
  }
  mergeEntry(source, target, "", result)
  return result
}

function filesUnder(root, predicate) {
  const files = []
  if (!pathExists(root)) return files
  const visit = (path) => {
    const entry = lstatOrNull(path)
    if (!entry || entry.isSymbolicLink()) return
    if (entry.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name))
    } else if (predicate(path)) {
      files.push(path)
    }
  }
  visit(root)
  return files
}

function transcriptEntries(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function canonicalPosition(entries, messageId) {
  if (typeof messageId !== "string" || messageId.length === 0) return -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      (entry?.kind === "user" || entry?.kind === "assistant")
      && entry.source_message_id === messageId
      && typeof entry.text === "string"
      && entry.text.trim().length > 0
    ) return index
  }
  return -1
}

function reconcileReflectionStates(candidateGroups) {
  const candidatesByTarget = new Map()
  for (const group of candidateGroups) {
    const current = candidatesByTarget.get(group.target) ?? []
    current.push(...group.states)
    candidatesByTarget.set(group.target, current)
  }
  for (const [statePath, groupedCandidates] of candidatesByTarget) {
    const transcriptPath = join(dirname(statePath), "transcript.jsonl")
    if (!pathExists(transcriptPath)) continue
    const entries = transcriptEntries(transcriptPath)
    const candidates = [...groupedCandidates, readJson(statePath)]
    const selected = candidates.reduce((best, candidate) => {
      const bestPosition = canonicalPosition(entries, best.reflected_through_message_id)
      const candidatePosition = canonicalPosition(entries, candidate.reflected_through_message_id)
      if (candidatePosition !== bestPosition) return candidatePosition > bestPosition ? candidate : best
      return (candidate.total_completed_steps ?? 0) > (best.total_completed_steps ?? 0) ? candidate : best
    })
    const state = { ...selected }
    const canonicalAssistant = (entry) =>
      entry?.kind === "assistant"
      && typeof entry.source_message_id === "string"
      && entry.source_message_id.length > 0
      && typeof entry.text === "string"
      && entry.text.trim().length > 0
    const total = entries.filter(canonicalAssistant).length
    const reflected = Math.min(
      Math.max(0, Number.isInteger(state.reflected_completed_steps) ? state.reflected_completed_steps : 0),
      total,
    )
    if (typeof state.reflected_through_message_id === "string") {
      const anchor = entries.findIndex(
        (entry) => canonicalAssistant(entry)
          && entry.source_message_id === state.reflected_through_message_id,
      )
      if (anchor < 0) delete state.reflected_through_message_id
    }
    state.total_completed_steps = total
    state.reflected_completed_steps = reflected
    state.steps_since_last_successful_reflection = Math.max(0, total - reflected)
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`)
  }
}

function reconcileFactsCursors(candidateGroups) {
  const candidatesByTarget = new Map()
  for (const group of candidateGroups) {
    const current = candidatesByTarget.get(group.target) ?? []
    current.push(...group.cursors)
    candidatesByTarget.set(group.target, current)
  }
  for (const [cursorPath, groupedCandidates] of candidatesByTarget) {
    const runtime = dirname(dirname(dirname(cursorPath)))
    const transcripts = filesUnder(
      join(runtime, "transcripts"),
      (path) => path.endsWith("/transcript.jsonl"),
    ).map(transcriptEntries)
    const candidates = [...groupedCandidates, readJson(cursorPath)]
    const positionOf = (candidate, field) => Math.max(
      -1,
      ...transcripts.map((entries) => canonicalPosition(entries, candidate[field])),
    )
    const selected = candidates.reduce((best, candidate) =>
      positionOf(candidate, "enqueued_through_message_id")
        > positionOf(best, "enqueued_through_message_id")
        ? candidate
        : best)
    const consumed = candidates.reduce((best, candidate) =>
      positionOf(candidate, "consumed_through_message_id")
        > positionOf(best, "consumed_through_message_id")
        ? candidate
        : best)
    const cursor = {
      ...selected,
      enqueued_through_snapshot_line: Math.max(
        -1,
        ...candidates.map((candidate) => candidate.enqueued_through_snapshot_line ?? -1),
      ),
      consumed_through_message_id: consumed.consumed_through_message_id,
      consumed_through_snapshot_line: Math.max(
        -1,
        ...candidates.map((candidate) => candidate.consumed_through_snapshot_line ?? -1),
      ),
    }
    atomicWrite(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`)
  }
}

function reconcileMemoryRuntime(results) {
  reconcileReflectionStates(results.flatMap((result) => result.stateCandidates))
  reconcileFactsCursors(results.flatMap((result) => result.factCandidates))
}

function repairMemoryWorktrees(target, results) {
  for (const candidate of results.flatMap((result) => result.worktreeCandidates)) {
    rmSync(candidate.targetPath, { recursive: true, force: true })
    mkdirSync(dirname(candidate.targetPath), { recursive: true })
    git(candidate.targetRepo, [
      "worktree",
      "add",
      "--force",
      candidate.targetPath,
      candidate.targetBranch,
    ])
  }
  const agentsRoot = join(target, "memory", "agents")
  if (!pathExists(agentsRoot)) return
  for (const agentName of readdirSync(agentsRoot)) {
    const repo = join(agentsRoot, agentName, "repo")
    const worktrees = join(agentsRoot, agentName, "runtime", "worktrees")
    if (!gitHead(repo) || !pathExists(worktrees)) continue
    for (const name of readdirSync(worktrees)) {
      const worktree = join(worktrees, name)
      if (pathExists(join(worktree, ".git"))) {
        git(repo, ["worktree", "repair", worktree], { allowFailure: true })
      }
    }
  }
}

function withMigrationLock(target, operation) {
  const lock = `${target}.omo-migration-lock`
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + 5 * 60_000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const lockStat = lstatOrNull(lock)
      if (!lockStat) continue
      const age = Date.now() - lockStat.mtimeMs
      if (age > 10 * 60_000) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`state migration lock timed out: ${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try {
    return operation()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function projectRoots(cwd, home) {
  const roots = []
  let current = resolve(cwd)
  const boundary = resolve(home)
  const fromHome = relativePath(boundary, current)
  if (
    isAbsolute(fromHome)
    || fromHome === ".."
    || fromHome.startsWith(`..${sep}`)
  ) return roots
  while (current !== boundary && dirname(current) !== current) {
    roots.push(current)
    current = dirname(current)
  }
  return roots.reverse()
}

export function resolveMigrationHome(env = process.env) {
  return env.HOME || env.USERPROFILE || homedir()
}

export function migrateRubatoState({ home = resolveMigrationHome(), cwd = process.cwd() } = {}) {
  const pairs = [[join(home, ".omo"), join(home, ".rubato")]]
  for (const root of projectRoots(cwd, home)) {
    pairs.push([join(root, ".omo"), join(root, ".rubato")])
  }
  const results = []
  for (const [source, target] of pairs) {
    const archives = [
      join(target, ".migration-archive", "omo"),
      join(target, ".migration-archive", "rubato"),
    ]
    if (!pathExists(source) && archives.every((path) => !pathExists(path))) continue
    const targetResults = withMigrationLock(target, () => {
      const lockedResults = [migrateRoot(source, target)]
      for (const archived of archives) {
        if (pathExists(archived)) lockedResults.push(migrateRoot(archived, target))
      }
      const archiveRoot = join(target, ".migration-archive")
      if (pathExists(archiveRoot) && readdirSync(archiveRoot).length === 0) rmdirSync(archiveRoot)
      const changed = lockedResults.some(
        (result) =>
          result.moved > 0
          || result.deduplicated > 0
          || result.resolved > 0
          || result.repositories > 0,
      )
      if (changed) {
        reconcileMemoryRuntime(lockedResults)
        repairMemoryWorktrees(target, lockedResults)
      }
      return lockedResults
    })
    results.push(...targetResults)
  }
  return results
}

function main() {
  const homeAt = process.argv.indexOf("--home")
  const cwdAt = process.argv.indexOf("--cwd")
  const results = migrateRubatoState({
    home: homeAt >= 0 ? process.argv[homeAt + 1] : resolveMigrationHome(),
    cwd: cwdAt >= 0 ? process.argv[cwdAt + 1] : process.cwd(),
  })
  const moved = results.reduce(
    (sum, result) => sum + result.moved + result.deduplicated + result.resolved + result.repositories,
    0,
  )
  if (moved > 0) process.stderr.write(`Rubato 설정·상태를 새 경로로 옮겼습니다: ${moved}개\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
