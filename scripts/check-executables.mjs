#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const listPath = join(repoRoot, "scripts/required-executables.txt")

export function parseRequired(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
}

export function collectIndexModes(lsFilesOutput) {
  const modes = new Map()
  for (const line of lsFilesOutput.split(/\r?\n/)) {
    if (!line) continue
    const tab = line.indexOf("\t")
    if (tab === -1) continue
    const mode = line.slice(0, line.indexOf(" "))
    const path = line.slice(tab + 1)
    modes.set(path, mode)
  }
  return modes
}

export function findFailures(required, indexModes, worktreeExecutable) {
  const failures = []
  for (const path of required) {
    const mode = indexModes.get(path)
    if (!mode) {
      failures.push(`${path}: missing from the git index`)
      continue
    }
    if (mode !== "100755") {
      failures.push(`${path}: index mode is ${mode}, expected 100755`)
    }
    if (worktreeExecutable.get(path) === false) {
      failures.push(`${path}: worktree is not executable`)
    }
  }
  return failures
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function loadRequired() {
  return parseRequired(readFileSync(listPath, "utf8"))
}

function worktreeExecutableMap(required) {
  const map = new Map()
  for (const path of required) {
    const abs = join(repoRoot, path)
    if (!existsSync(abs)) continue
    map.set(path, (statSync(abs).mode & 0o111) !== 0)
  }
  return map
}

function healStaged(required) {
  const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split(/\r?\n/)
    .filter(Boolean)
  const requiredSet = new Set(required)
  const healed = []
  for (const path of staged) {
    if (!requiredSet.has(path)) continue
    const abs = join(repoRoot, path)
    if (existsSync(abs) && (statSync(abs).mode & 0o111) === 0) {
      chmodSync(abs, 0o755)
    }
    git(["update-index", "--chmod=+x", "--", path])
    healed.push(path)
  }
  return healed
}

function report(failures) {
  console.error([
    "required executables lost their +x bit.",
    "Agents that rewrite a script often commit it as 100644; restore with:",
    "  git update-index --chmod=+x -- <path>",
    "or run `node scripts/check-executables.mjs --heal-index` on a staged change.",
    "",
    ...failures.map((line) => `  ${line}`),
  ].join("\n"))
}

export function main(argv = process.argv.slice(2)) {
  const required = loadRequired()
  if (argv.includes("--heal-index")) {
    const healed = healStaged(required)
    if (healed.length > 0) {
      console.error(`restored +x on ${healed.length} staged path(s):`)
      for (const path of healed) console.error(`  ${path}`)
    }
  }

  const indexModes = collectIndexModes(git(["ls-files", "-s"]))
  const failures = findFailures(required, indexModes, worktreeExecutableMap(required))
  if (failures.length > 0) {
    report(failures)
    process.exitCode = 1
    return failures
  }
  return []
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main()
}
