import { mkdir } from "node:fs/promises"

import type { MemoryIdentityPaths } from "@rubato/memory-core"

import type { MemorySessionBinding } from "./binding"

export interface MemoryIdentityContext {
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
  readonly binding: MemorySessionBinding
}

export function createMemoryIdentityContext(input: {
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
  readonly binding: MemorySessionBinding
}): MemoryIdentityContext {
  return { identity: input.identity, identityPaths: input.identityPaths, binding: input.binding }
}

/** First-write seam: callers invoke this before mutation; reads must never create identity storage. */
export async function ensureIdentityRuntimeDirs(paths: MemoryIdentityPaths): Promise<void> {
  await mkdir(paths.locks, { recursive: true })
}
