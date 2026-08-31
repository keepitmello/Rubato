#!/usr/bin/env node
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { BUNDLED_NOTICE_HEADINGS, PACKAGE_NOTICE_REQUIREMENTS } from "./third-party-notice-requirements.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const WINDOWS_CMD_SHIM_COMMANDS = new Set(["npm", "npx"])
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"])

const scopes = {
  root: {
    noticePath: "THIRD-PARTY-NOTICES.md",
    requiredComponents() {
      return [...readRetainedProductionDependencyNames(), ...BUNDLED_NOTICE_HEADINGS]
    },
    checkComponents: checkBundledEvidence,
    checkSummary: "bundled license evidence: zmx and npm lock policy checked",
  },
  packages: {
    noticePath: "THIRD-PARTY-NOTICES.md",
    requiredComponents() {
      return []
    },
    checkComponents: checkPackageNotices,
    checkSummary: `package NOTICE files: ${PACKAGE_NOTICE_REQUIREMENTS.length} retained packages checked`,
  },
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function headingExists(noticeText, component) {
  const pattern = new RegExp(`^###\\s+${escapeRegExp(component)}(?:@|\\s|\\(|$)`, "im")
  return pattern.test(noticeText)
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"))
}

function isSkippedPackageManifest(relativePath) {
  return relativePath.split(/[\\/]/).includes("skills")
}

function collectPackageJsonRelativePaths(dir = join(repoRoot, "packages"), acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectPackageJsonRelativePaths(full, acc)
      continue
    }
    if (entry.name !== "package.json") continue
    const relativePath = relative(repoRoot, full)
    if (!isSkippedPackageManifest(relativePath)) acc.push(relativePath)
  }
  return acc
}

function readRetainedProductionDependencyNames() {
  const names = []
  for (const packagePath of collectPackageJsonRelativePaths()) {
    const packageJson = readJson(packagePath)
    for (const [name, spec] of Object.entries({ ...(packageJson.dependencies ?? {}), ...(packageJson.optionalDependencies ?? {}) })) {
      if (name.startsWith("@rubato/")) continue
      if (typeof spec === "string" && (spec.startsWith("workspace:") || spec.startsWith("file:"))) continue
      names.push(name)
    }
  }
  return unique(names)
}

function checkBundledEvidence() {
  const failures = []
  try {
    const lock = readJson("third_party/zmx-lock.json")
    const licensePath = join(repoRoot, "third_party", lock.license.path)
    const actual = createHash("sha256").update(readFileSync(licensePath)).digest("hex")
    if (actual !== lock.license.sha256) failures.push("third_party/zmx license hash differs from zmx-lock.json")
    if (lock.license.spdx !== "MIT") failures.push("third_party/zmx license is not pinned as MIT")
  } catch (error) {
    failures.push(`third_party/zmx evidence is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!existsSync(join(repoRoot, "third_party", "npm-license-policy.json"))) failures.push("third_party/npm-license-policy.json is missing")
  return failures
}

function checkPackageNotices() {
  const failures = []

  for (const requirement of PACKAGE_NOTICE_REQUIREMENTS) {
    const noticePath = join(repoRoot, requirement.path, "NOTICE")
    if (!existsSync(noticePath)) {
      failures.push(`${requirement.path}/NOTICE is missing`)
      continue
    }
    for (const filename of requirement.requiredFiles ?? ["NOTICE"]) {
      if (!existsSync(join(repoRoot, requirement.path, filename))) {
        failures.push(`${requirement.path}/${filename} is missing`)
      }
    }

    const noticeText = readFileSync(noticePath, "utf8")
    for (const term of requirement.requiredTerms) {
      if (!noticeText.includes(term)) {
        failures.push(`${requirement.path}/NOTICE is missing required term: ${term}`)
      }
    }
    for (const term of requirement.forbiddenTerms ?? []) {
      if (noticeText.includes(term)) {
        failures.push(`${requirement.path}/NOTICE must not reference removed payload path: ${term}`)
      }
    }
  }

  return failures
}

function runScope(scopeName) {
  const scope = scopes[scopeName]
  if (!scope) {
    console.error(`Unsupported notice scope: ${scopeName}`)
    process.exitCode = 2
    return
  }

  const resolvedNoticePath = join(repoRoot, scope.noticePath)
  if (!existsSync(resolvedNoticePath)) {
    console.error(`${scope.noticePath} is missing`)
    process.exitCode = 1
    return
  }

  const noticeText = readFileSync(resolvedNoticePath, "utf8")
  const requiredComponents = unique(scope.requiredComponents())
  const missing = requiredComponents.filter((component) => !headingExists(noticeText, component))
  const componentFailures = scope.checkComponents?.() ?? []

  if (missing.length > 0 || componentFailures.length > 0) {
    if (missing.length > 0) {
      console.error(`${scope.noticePath} is missing ${missing.length} required notice entries:`)
    }
    for (const component of missing) console.error(`- ${component}`)
    for (const failure of componentFailures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }

  if (requiredComponents.length > 0) {
    console.log(`${scope.noticePath}: ${requiredComponents.length} required notice entries present`)
  }
  if (scope.checkSummary) console.log(scope.checkSummary)
}

function runShipCheck() {
  const failures = []
  const requiredPackTargets = []

  if (!existsSync(join(repoRoot, "THIRD-PARTY-NOTICES.md"))) {
    failures.push("THIRD-PARTY-NOTICES.md is missing")
  }

  for (const requirement of PACKAGE_NOTICE_REQUIREMENTS) {
    const packagePath = `${requirement.path}/package.json`
    if (!existsSync(join(repoRoot, packagePath))) {
      failures.push(`${packagePath} is missing`)
      continue
    }
    const packageJson = readJson(packagePath)
    const packageFiles = packageJson.files ?? []
    for (const filename of requirement.requiredFiles ?? ["NOTICE"]) {
      const filePath = join(repoRoot, requirement.path, filename)
      if (!existsSync(filePath)) {
        failures.push(`${requirement.path}/${filename} is missing`)
        continue
      }
      if (Array.isArray(packageJson.files) && !packageFiles.includes(filename)) {
        failures.push(`${packagePath} files[] is missing ${filename}`)
      }
    }

    if (Array.isArray(packageJson.files) && packageJson.files.includes("NOTICE") && existsSync(join(repoRoot, requirement.path, "NOTICE"))) {
      requiredPackTargets.push({
        cwd: requirement.path,
        requiredPaths: (requirement.requiredFiles ?? ["NOTICE"]).filter((filename) => existsSync(join(repoRoot, requirement.path, filename))),
      })
    }
  }

  for (const target of requiredPackTargets) {
    const packFiles = readDryRunPackFiles(join(repoRoot, target.cwd))
    for (const filename of target.requiredPaths) {
      if (!packFiles.has(filename)) {
        failures.push(`npm pack dry-run for ${target.cwd} is missing ${filename}`)
      }
    }
  }

  if (failures.length > 0) {
    console.error(`ship verification failed with ${failures.length} issue(s):`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }

  console.log(`ship verification passed: ${requiredPackTargets.length} packaged NOTICE payload(s) checked`)
}

function readDryRunPackFiles(cwd) {
  const npmPackArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"]
  const invocation = resolveSpawnSyncInvocation("npm", npmPackArgs)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.stdout.write(result.stdout)
    throw new Error(`npm pack --dry-run --json --ignore-scripts failed with exit ${result.status} in ${cwd}`)
  }
  const packJson = parseNpmPackJson(result.stdout)
  return new Set(packJson[0].files.map((file) => file.path.replaceAll("\\", "/").split("/").pop()))
}

export function resolveSpawnSyncInvocation(command, args, platform = process.platform) {
  const invocation = { command, args: Array.from(args) }
  if (platform !== "win32" || !WINDOWS_CMD_SHIM_COMMANDS.has(command.toLowerCase())) return invocation

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `${command}.cmd`, ...invocation.args],
  }
}

export function parseNpmPackJson(output) {
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "[" && output[index] !== "{") continue
    try {
      const parsed = JSON.parse(output.slice(index))
      const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : []
      if (entries.length === 1 && entries.every(isNpmPackEntry)) return entries
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  throw new Error("npm pack --dry-run --json did not produce a parseable file list")
}

function isNpmPackEntry(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.files) &&
    value.files.every((file) => file !== null && typeof file === "object" && typeof file.path === "string")
  )
}

function isMainModule() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
}

function main(args = process.argv.slice(2)) {
  if (args.includes("--ship")) {
    runShipCheck()
  } else if (args.includes("--codex") || args.includes("--packages")) {
    runScope("packages")
  } else {
    runScope("root")
  }
}

if (isMainModule()) {
  main()
}
