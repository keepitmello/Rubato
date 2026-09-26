import { mkdir } from "node:fs/promises"

import type { MemoryIdentityPaths } from "@rubato/memory-core"

import type { MemorySessionBinding } from "./binding"

export interface MemoryIdentityContext {
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
  readonly binding: MemorySessionBinding
  /** Project root the session bound from; store.json records it on the first write. */
  readonly root?: string
  /** True for the home-directory store. */
  readonly home?: boolean
}

export function createMemoryIdentityContext(input: {
  readonly identity: string
  readonly identityPaths: MemoryIdentityPaths
  readonly binding: MemorySessionBinding
  readonly root?: string
  readonly home?: boolean
}): MemoryIdentityContext {
  return {
    identity: input.identity,
    identityPaths: input.identityPaths,
    binding: input.binding,
    ...(input.root === undefined ? {} : { root: input.root }),
    ...(input.home === true ? { home: true } : {}),
  }
}

/** First-write seam: callers invoke this before mutation; reads must never create identity storage. */
export async function ensureIdentityRuntimeDirs(paths: MemoryIdentityPaths): Promise<void> {
  await mkdir(paths.locks, { recursive: true })
}
