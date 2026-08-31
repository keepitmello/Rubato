import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export async function writePrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await ensurePrivateDirectory(dirname(path))
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

export async function appendPrivateLine(path: string, line: string, sync = false): Promise<void> {
  await ensurePrivateDirectory(dirname(path))
  const handle = await open(path, "a", 0o600)
  try {
    await handle.write(`${line}\n`)
    if (sync) await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (error) {
    if (isMissing(error)) return fallback
    throw error
  }
}

export async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true })
}

export async function assertPrivateFile(path: string): Promise<void> {
  const info = await stat(path)
  if ((info.mode & 0o077) !== 0) throw new Error(`insecure permissions on ${path}`)
}

export function isPathInside(path: string, root: string): boolean {
  const normalizedPath = resolve(path)
  const normalizedRoot = resolve(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
