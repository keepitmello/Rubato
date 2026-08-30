#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

function sameFile(left, right) {
  const a = readFileSync(left)
  const b = readFileSync(right)
  return a.length === b.length && a.equals(b)
}

function migratedName(name) {
  if (name === "omo.json" || name.startsWith("omo.json.")) return name.replace(/^omo\.json/, "rubato.json")
  if (name === "omo.jsonc" || name.startsWith("omo.jsonc.")) return name.replace(/^omo\.jsonc/, "rubato.jsonc")
  return name
}

function mergeEntry(source, target, result) {
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink()) {
    result.conflicts.push(source)
    return
  }
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(source, target)
    result.moved += 1
    return
  }
  const targetStat = lstatSync(target)
  if (sourceStat.isDirectory() && targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
    for (const name of readdirSync(source)) mergeEntry(join(source, name), join(target, migratedName(name)), result)
    if (readdirSync(source).length === 0) rmdirSync(source)
    return
  }
  if (sourceStat.isFile() && targetStat.isFile() && sameFile(source, target)) {
    unlinkSync(source)
    result.deduplicated += 1
    return
  }
  result.conflicts.push(source)
}

export function migrateRoot(source, target) {
  const result = { source, target, moved: 0, deduplicated: 0, conflicts: [] }
  if (!existsSync(source)) return result
  if (lstatSync(source).isSymbolicLink()) {
    result.conflicts.push(source)
    return result
  }
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true })
  }
  mergeEntry(source, target, result)
  return result
}

function projectRoots(cwd, home) {
  const roots = []
  let current = resolve(cwd)
  const boundary = resolve(home)
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
  return pairs.map(([source, target]) => migrateRoot(source, target))
}

function main() {
  const homeAt = process.argv.indexOf("--home")
  const cwdAt = process.argv.indexOf("--cwd")
  const results = migrateRubatoState({
    home: homeAt >= 0 ? process.argv[homeAt + 1] : resolveMigrationHome(),
    cwd: cwdAt >= 0 ? process.argv[cwdAt + 1] : process.cwd(),
  })
  const moved = results.reduce((sum, result) => sum + result.moved + result.deduplicated, 0)
  const conflicts = results.flatMap((result) => result.conflicts)
  if (moved > 0) process.stderr.write(`Rubato 설정·상태를 새 경로로 옮겼습니다: ${moved}개\n`)
  if (conflicts.length > 0) {
    process.stderr.write("새 경로와 내용이 달라 남겨 둔 기존 항목:\n")
    for (const path of conflicts) process.stderr.write(`  ${path}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
