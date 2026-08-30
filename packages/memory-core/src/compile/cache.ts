import { createHash } from "node:crypto"
import type { GitMemoryRepo } from "../git"
import {
  compileMemoryBlockAtRevision,
  normalizeProject,
  type CompileMemoryBlockOptions,
} from "./compile"

export const MEMORY_TEMPLATE_STRUCTURE_VERSION = "senpi-memory-v2"

export function hashMemoryTemplate(template: string): string {
  return createHash("sha256")
    .update(MEMORY_TEMPLATE_STRUCTURE_VERSION)
    .update("\0")
    .update(template)
    .digest("hex")
}

interface MemoryBlockCacheEntry {
  readonly variant: string
  readonly pending: Promise<string>
}

export class MemoryBlockCache {
  private readonly entries = new Map<string, MemoryBlockCacheEntry>()

  get size(): number {
    return this.entries.size
  }

  async compile(
    repo: GitMemoryRepo,
    template: string,
    options: CompileMemoryBlockOptions,
  ): Promise<string> {
    const revision = await repo.head()
    const key = `${hashMemoryTemplate(template)}:${options.agentId}`
    // The variant must cover every input that changes the compiled output, not just HEAD.
    // Options that alter the result belong here rather than in the caller's template string:
    // a caller that forgot to encode one would silently be served the other variant's block.
    const variant = `${revision ?? "no-head"}:project=${normalizeProject(options.project).join(",")}`
    const existing = this.entries.get(key)
    if (existing?.variant === variant) return existing.pending

    const pending = compileMemoryBlockAtRevision(repo, revision, options)
    const entry = { variant, pending }
    this.entries.set(key, entry)
    try {
      return await pending
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
