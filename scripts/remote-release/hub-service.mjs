// What the profile engine runs as the remote hub (harness/pi-server/src/hub-supervisor.mjs).
// The release channel writes it; the engine reads it. Both use this file, so the shape has one
// definition, and the installed release copy of these scripts carries it without the checkout.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export const HUB_SERVICE_SCHEMA = 1

/** The hub spec as the release channel writes it, or an Error saying why it cannot run. */
export function parseHubServiceSpec(text) {
  let value
  try { value = JSON.parse(text) } catch { return new Error("hub service spec is not JSON") }
  if (!value || typeof value !== "object" || value.schemaVersion !== HUB_SERVICE_SCHEMA) return new Error("hub service spec has an unknown schema")
  const absolute = (item) => typeof item === "string" && path.isAbsolute(item)
  if (!absolute(value.command)) return new Error("hub service command must be an absolute path")
  if (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")) return new Error("hub service args must be strings")
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)
    || !Object.entries(value.env).every(([key, item]) => key && !key.includes("=") && typeof item === "string")) return new Error("hub service env must map names to strings")
  if (!absolute(value.stdout) || !absolute(value.stderr)) return new Error("hub service logs must be absolute paths")
  return value
}

/**
 * Reads the spec only when this user alone can write it: the engine executes what it names, so a
 * file another user could change would hand them this account.
 */
export async function readHubServiceSpec(file, uid = process.getuid?.()) {
  let info
  try { info = await stat(file) } catch (error) { if (error.code === "ENOENT") return null; throw error }
  if (!info.isFile()) return new Error("hub service spec is not a file")
  if (uid !== undefined && info.uid !== uid) return new Error("hub service spec has the wrong owner")
  if ((info.mode & 0o022) !== 0) return new Error("hub service spec is writable by other users")
  const text = await readFile(file, "utf8")
  const spec = parseHubServiceSpec(text)
  return spec instanceof Error ? spec : { spec, text }
}

export async function writeHubServiceSpec(file, spec) {
  const checked = parseHubServiceSpec(JSON.stringify(spec))
  if (checked instanceof Error) throw checked
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  await rename(temporary, file)
}
