import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmod, cp, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import { REDACTED } from "./constants.mjs"

export const SECRET_KEY = /(?:authorization|cookie|token|secret|password|private.?key|auth.?key|vapid|ciphertext)/i
export const SECRET_VALUE = /(?:Bearer\s+\S+|tskey-[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/gi

export function redact(value, key = "") {
  if (SECRET_KEY.test(key)) return REDACTED
  if (typeof value === "string") return value.replace(SECRET_VALUE, REDACTED)
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]))
  return value
}

export function commandString(file, args = []) {
  return [file, ...args].map((part) => /[^A-Za-z0-9_./:=@+-]/.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part).join(" ")
}

export async function run(file, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    shell: false,
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk) => { stdout += chunk })
  child.stderr?.on("data", (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  timer.unref?.()
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolveResult({ code: code ?? 128, signal, stdout, stderr }))
  }).finally(() => clearTimeout(timer))
  if (options.check !== false && result.code !== 0) {
    const error = new Error(`${commandString(file, args)} exited ${result.code}${result.stderr.trim() ? `: ${redact(result.stderr.trim())}` : ""}`)
    Object.assign(error, result)
    throw error
  }
  return result
}

export async function sha256(path) {
  const hash = createHash("sha256")
  const handle = await open(path, "r")
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

export async function writePrivate(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

export async function writeJsonPrivate(path, value) {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) {
    if (error?.code === "ENOENT" && arguments.length > 1) return fallback
    throw error
  }
}

export async function ensurePrivateDirectories(paths) {
  for (const path of paths) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }
}

export async function atomicSymlink(target, path) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await symlink(target, temporary)
  await rename(temporary, path)
}

export function isInside(path, root) {
  const candidate = resolve(path)
  const boundary = resolve(root)
  return candidate === boundary || candidate.startsWith(`${boundary}${sep}`)
}

export async function assertSafeReleaseDirectory(path, releasesRoot) {
  const parent = await realpath(dirname(path))
  const root = await realpath(releasesRoot)
  if (!isInside(parent, root) || parent !== root) throw new Error("release destination escapes releases root")
  if (existsSync(path)) {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("release destination is not a real directory")
  }
}

export async function copyTree(source, destination, filter = () => true) {
  await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true, filter })
}

export async function removeTreeInside(path, root) {
  const rootReal = await realpath(root)
  const parentReal = await realpath(dirname(path))
  const candidate = join(parentReal, basename(path))
  if (parentReal !== rootReal || !isInside(candidate, rootReal)) throw new Error("refusing to remove path outside managed root")
  const info = await lstat(path).catch(() => null)
  if (info?.isSymbolicLink()) throw new Error("refusing to recursively remove a symlink")
  if (info) await rm(path, { recursive: true, force: true })
}

export async function fileMode(path) {
  return (await stat(path)).mode & 0o777
}

export function uuidV7(now = Date.now()) {
  const bytes = randomBytes(16)
  let timestamp = BigInt(now)
  for (let index = 5; index >= 0; index -= 1) { bytes[index] = Number(timestamp & 0xffn); timestamp >>= 8n }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function relativeTarget(target, linkPath) {
  return relative(dirname(linkPath), target) || "."
}

export async function currentRelease(path) {
  try {
    const target = await readlink(path)
    return resolve(dirname(path), target)
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EINVAL") return null
    throw error
  }
}

export async function pathExists(path) {
  try { await stat(path); return true } catch (error) { if (error?.code === "ENOENT") return false; throw error }
}

export function parseJsonOutput(result, description) {
  try { return JSON.parse(result.stdout) }
  catch { throw new Error(`${description} returned invalid JSON`) }
}
