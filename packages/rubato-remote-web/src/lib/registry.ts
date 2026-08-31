import { registeredHostSchema } from "@rubato/remote-protocol"
import { openDB } from "idb"
import type { RegisteredHost } from "./types"

const DB_NAME = "rubato-remote"
const STORE = "hosts"

async function database() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "hostId" })
    },
  })
}

export async function listRegisteredHosts(): Promise<RegisteredHost[]> {
  const values: unknown[] = await (await database()).getAll(STORE)
  return values.map((value) => registeredHostSchema.parse(value))
}

export async function saveRegisteredHost(host: RegisteredHost): Promise<void> {
  await (await database()).put(STORE, host)
}

export async function removeRegisteredHost(hostId: string): Promise<void> {
  await (await database()).delete(STORE, hostId)
}

export async function exportRegisteredHosts(): Promise<string> {
  return JSON.stringify(await listRegisteredHosts(), null, 2)
}

export async function importRegisteredHosts(json: string): Promise<number> {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) throw new Error("호스트 목록 파일이 올바르지 않아요.")
  const hosts = value.map(parseHost)
  const db = await database()
  const tx = db.transaction(STORE, "readwrite")
  await Promise.all([...hosts.map((host) => tx.store.put(host)), tx.done])
  return hosts.length
}

export function parseHost(value: unknown): RegisteredHost {
  return registeredHostSchema.parse(value)
}
