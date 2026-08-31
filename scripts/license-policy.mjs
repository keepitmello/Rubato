#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const lockPath = join(root, "bun.lock")
const policyPath = join(root, "third_party", "npm-license-policy.json")
const ALLOWED = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "MPL-2.0"])
const FORBIDDEN = /(?:^|[^A-Z])A?GPL(?:-|$)/i

export function parseJsonc(text) {
  let output = ""
  let string = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (string) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') string = false
      continue
    }
    if (char === '"') { string = true; output += char; continue }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      output += "\n"
      continue
    }
    if (char === ",") {
      let lookahead = index + 1
      while (/\s/.test(text[lookahead] ?? "")) lookahead += 1
      if (text[lookahead] === "]" || text[lookahead] === "}") continue
    }
    output += char
  }
  return JSON.parse(output)
}

export function lockedRegistryPackages(lock) {
  const packages = new Map()
  for (const value of Object.values(lock.packages ?? {})) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue
    const parsed = splitPackageVersion(value[0])
    if (!parsed || parsed.version.startsWith("file:") || parsed.version.startsWith("workspace:") || parsed.version.startsWith("git")) continue
    packages.set(`${parsed.name}@${parsed.version}`, parsed)
  }
  return [...packages.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
}

export function splitPackageVersion(value) {
  const separator = value.lastIndexOf("@")
  if (separator <= 0 || separator === value.length - 1) return null
  return { name: value.slice(0, separator), version: value.slice(separator + 1) }
}

export function normalizeLicense(metadata) {
  const raw = typeof metadata.license === "string" ? metadata.license : metadata.license?.type ?? (Array.isArray(metadata.licenses) ? metadata.licenses.map((item) => typeof item === "string" ? item : item?.type).filter(Boolean).join(" OR ") : "")
  return String(raw).trim().replace(/^\((.*)\)$/, "$1") || "UNKNOWN"
}

export function licenseTerms(expression) {
  return expression.replace(/[()]/g, " ").split(/\s+(?:AND|OR|WITH)\s+/i).map((term) => term.trim()).filter(Boolean)
}

export function validatePolicy(packages, policy) {
  const failures = []
  const records = new Map((policy.packages ?? []).map((item) => [`${item.name}@${item.version}`, item]))
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`
    const record = records.get(key)
    if (!record) { failures.push(`${key}: missing license record`); continue }
    records.delete(key)
    if (!record.license || record.license === "UNKNOWN") { failures.push(`${key}: unknown license`); continue }
    if (FORBIDDEN.test(record.license)) { failures.push(`${key}: forbidden copyleft license ${record.license}`); continue }
    const terms = licenseTerms(record.license)
    const unapproved = terms.filter((term) => !ALLOWED.has(term))
    if (unapproved.length > 0 && record.approvedException !== true) failures.push(`${key}: unapproved license ${record.license}`)
    if (record.approvedException === true && !record.exceptionReason) failures.push(`${key}: license exception has no reason`)
  }
  for (const stale of records.keys()) failures.push(`${stale}: stale license record not present in bun.lock`)
  return failures
}

async function localMetadata() {
  const index = new Map()
  const bunRoot = join(root, "node_modules", ".bun")
  if (!existsSync(bunRoot)) return index
  for (const directory of await readdir(bunRoot)) {
    const packageRoot = join(bunRoot, directory, "node_modules")
    for (const path of await packageJsonPaths(packageRoot)) {
      try {
        const metadata = JSON.parse(await readFile(path, "utf8"))
        if (metadata.name && metadata.version) index.set(`${metadata.name}@${metadata.version}`, metadata)
      } catch {}
    }
  }
  return index
}

async function packageJsonPaths(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".")) continue
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scoped of await readdir(join(directory, entry.name), { withFileTypes: true }).catch(() => [])) {
        if (scoped.isDirectory() && existsSync(join(directory, entry.name, scoped.name, "package.json"))) output.push(join(directory, entry.name, scoped.name, "package.json"))
      }
    } else if (entry.isDirectory() && existsSync(join(directory, entry.name, "package.json"))) output.push(join(directory, entry.name, "package.json"))
  }
  return output
}

async function registryMetadata(name, version) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${name}@${version}: npm registry returned ${response.status}`)
  return response.json()
}

async function updatePolicy(packages) {
  const local = await localMetadata()
  const previous = existsSync(policyPath) ? JSON.parse(await readFile(policyPath, "utf8")) : { packages: [] }
  const previousMap = new Map((previous.packages ?? []).map((item) => [`${item.name}@${item.version}`, item]))
  const records = []
  for (const [index, pkg] of packages.entries()) {
    const key = `${pkg.name}@${pkg.version}`
    const metadata = local.get(key) ?? await registryMetadata(pkg.name, pkg.version)
    const old = previousMap.get(key)
    const discoveredLicense = normalizeLicense(metadata)
    const license = discoveredLicense === "UNKNOWN" && old?.license && old.license !== "UNKNOWN" ? old.license : discoveredLicense
    records.push({ name: pkg.name, version: pkg.version, license, ...(old?.approvedException ? { approvedException: true, exceptionReason: old.exceptionReason } : {}) })
    if ((index + 1) % 100 === 0) process.stderr.write(`license metadata: ${index + 1}/${packages.length}\n`)
  }
  await writeFile(policyPath, `${JSON.stringify({ schemaVersion: 1, generatedFrom: "bun.lock", packages: records }, null, 2)}\n`)
  return { schemaVersion: 1, packages: records }
}

async function main() {
  const lock = parseJsonc(await readFile(lockPath, "utf8"))
  const packages = lockedRegistryPackages(lock)
  const policy = process.argv.includes("--update") ? await updatePolicy(packages) : JSON.parse(await readFile(policyPath, "utf8"))
  const failures = validatePolicy(packages, policy)
  if (failures.length > 0) {
    console.error(`license policy failed with ${failures.length} issue(s):`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
  } else console.log(`license policy passed: ${packages.length} locked registry packages checked`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch((error) => { console.error(`license-policy: ${error.message}`); process.exitCode = 1 })
