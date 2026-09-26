import path from "node:path"

export const LOCK_DOMAINS = [
  "memory-write",
] as const

export type LockDomain = (typeof LOCK_DOMAINS)[number]

export function memoryWriterLockPath(locksDirectory: string): string {
  return path.join(locksDirectory, "memory-write.lock")
}
