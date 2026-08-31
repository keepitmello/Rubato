import { homedir, hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { isUuidV7, type HostId } from "@rubato/remote-protocol"
import { readJson, writePrivateFile } from "./files.js"
import { uuidV7 } from "./uuid.js"

export interface HostConfig {
  readonly schemaVersion: 1
  readonly hostId: HostId
  readonly displayName: string
  readonly ownerLogin: string
  readonly httpPort: number
  readonly createdAt: string
}

export interface HubPaths {
  readonly root: string
  readonly host: string
  readonly origins: string
  readonly journal: string
  readonly snapshots: string
  readonly push: string
  readonly keys: string
  readonly socketDirectory: string
  readonly socket: string
}

export function defaultHubPaths(uid = process.getuid?.() ?? 0): HubPaths {
  const root = join(homedir(), "Library", "Application Support", "Rubato", "remote")
  const socketDirectory = join(tmpdir(), `rubato-remote-${uid}`)
  return {
    root,
    host: join(root, "host.json"),
    origins: join(root, "origins.json"),
    journal: join(root, "journal"),
    snapshots: join(root, "snapshots"),
    push: join(root, "push"),
    keys: join(root, "keys"),
    socketDirectory,
    socket: join(socketDirectory, "hub.sock"),
  }
}

export async function loadHostConfig(path: string): Promise<HostConfig> {
  const config = await readJson<HostConfig | null>(path, null)
  if (!config) throw new Error(`host config not found: ${path}`)
  if (!validHostConfig(config)) throw new Error("invalid host config")
  return config
}

export async function ensureHostConfig(path: string, defaults: { displayName?: string; ownerLogin?: string; httpPort?: number } = {}): Promise<HostConfig> {
  const current = await readJson<Partial<HostConfig> | null>(path, null)
  if (current && validHostConfig(current)) return current
  const hostId = isUuidV7(current?.hostId) ? current.hostId : uuidV7()
  const config: HostConfig = {
    schemaVersion: 1,
    hostId,
    displayName: nonEmpty(defaults.displayName) ?? hostname(),
    ownerLogin: nonEmpty(defaults.ownerLogin) ?? process.env["USER"] ?? "rubato",
    httpPort: defaults.httpPort ?? 7314,
    createdAt: typeof current?.createdAt === "string" && Number.isFinite(Date.parse(current.createdAt)) ? current.createdAt : new Date().toISOString(),
  }
  if (!validHostConfig(config)) throw new Error("invalid host config defaults")
  await saveHostConfig(path, config)
  return config
}

export async function saveHostConfig(path: string, config: HostConfig): Promise<void> {
  if (!validHostConfig(config)) throw new Error("invalid host config")
  await writePrivateFile(path, JSON.stringify(config, null, 2))
}

function validHostConfig(value: Partial<HostConfig>): value is HostConfig {
  return value.schemaVersion === 1 && isUuidV7(value.hostId) && nonEmpty(value.displayName) !== undefined &&
    nonEmpty(value.ownerLogin) !== undefined && Number.isSafeInteger(value.httpPort) && value.httpPort! >= 7314 &&
    value.httpPort! <= 7399 && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}
