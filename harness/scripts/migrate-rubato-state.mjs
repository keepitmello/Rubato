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

function archiveEntry(source, target, result) {
  let destination = target
  let suffix = 1
  while (pathExists(source)) {
    const sourceStat = lstatOrNull(source)
    if (!sourceStat) return
    const targetStat = lstatOrNull(destination)
    if (!targetStat) {
      mkdirSync(dirname(destination), { recursive: true })
      try {
        renameSync(source, destination)
        result.archived += 1
        return
      } catch (error) {
        if (error?.code === "ENOENT") return
        if (error?.code === "EEXIST") continue
        throw error
      }
    }
    if (sourceStat.isFile() && targetStat.isFile() && sameFile(source, destination)) {
      if (ignoreGone(() => unlinkSync(source))) result.deduplicated += 1
      return
    }
    destination = `${target}.${suffix}`
    suffix += 1
  }
}

function mergeEntry(source, target, sourceArchive, targetArchive, result) {
  const sourceStat = lstatOrNull(source)
  if (!sourceStat) return
  let targetStat = lstatOrNull(target)

  // 끊어진 새 경로 링크도 보존하되, 그것이 실제 데이터를 가로막지는 않게 한다.
  if (targetStat?.isSymbolicLink() && !existsSync(target)) {
    archiveEntry(target, targetArchive, result)
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
        mergeEntry(source, target, sourceArchive, targetArchive, result)
        return
      }
      throw error
    }
    return
  }

  if (sourceStat.isSymbolicLink()) {
    archiveEntry(source, sourceArchive, result)
    return
  }
  if (sourceStat.isDirectory() && targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
    for (const name of readdirSync(source)) {
      mergeEntry(
        join(source, name),
        join(target, migratedName(name)),
        join(sourceArchive, name),
        join(targetArchive, migratedName(name)),
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
  archiveEntry(source, sourceArchive, result)
}

export function migrateRoot(source, target) {
  const result = { source, target, moved: 0, deduplicated: 0, archived: 0 }
  if (!pathExists(source)) return result
  const sourceArchive = join(target, ".migration-archive", "omo")
  const targetArchive = join(target, ".migration-archive", "rubato")
  if (!pathExists(target)) {
    if (lstatSync(source).isSymbolicLink()) {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(source, target)
      result.moved += 1
      return result
    }
    mkdirSync(target, { recursive: true })
  }
  mergeEntry(source, target, sourceArchive, targetArchive, result)
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
  const moved = results.reduce((sum, result) => sum + result.moved + result.deduplicated + result.archived, 0)
  const archived = results.reduce((sum, result) => sum + result.archived, 0)
  if (moved > 0) process.stderr.write(`Rubato 설정·상태를 새 경로로 옮겼습니다: ${moved}개\n`)
  if (archived > 0) process.stderr.write(`겹친 기존 항목은 .rubato/.migration-archive/omo에 보관했습니다: ${archived}개\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
