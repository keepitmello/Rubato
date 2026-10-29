import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { GitMemoryRepo, selfRepoPath } from "@rubato/memory-core"

import type { SessionEntryLike } from "./binding"

// The resident layer: soul.md (what the user adds to the agent's personality) from the self store.
// It goes into the system prompt whole, once per session: the prompt is re-composed for every
// request, so the block is taken at session start and reused, and an edit mid-session waits for the
// next session instead of rewriting the cached prefix. The snapshot is recorded in the session so a
// resumed session keeps it.
//
// Facts about the person are not resident. They live in the shared user store (USER_STORE_ID), which
// agents search when a question needs them; a profile loaded whole into every prompt only grows. A
// legacy user.md is carried into that store by the user dream and is never loaded here, and a session
// recorded before that keeps its personality but loses its <user> section when resumed.

export const RESIDENT_ENTRY_TYPE = "rubato-memory:resident"
export const RESIDENT_FILES = ["soul.md"] as const

export interface ResidentSnapshot {
  /** The composed block, or "" when both files are missing or empty. */
  readonly block: string
}

/** Reads soul.md from the self store's working tree; a missing or empty file adds nothing. */
export function readResidentBlock(memoryRoot: string): string {
  const repo = selfRepoPath(memoryRoot)
  const sections: string[] = []
  for (const file of RESIDENT_FILES) {
    const body = readText(join(repo, file))
    if (body === "") continue
    const tag = file.replace(/\.md$/, "")
    sections.push(`<${tag} path="${join(repo, file)}">\n${body}\n</${tag}>`)
  }
  return sections.length === 0 ? "" : `<memory>\n${sections.join("\n\n")}\n</memory>`
}

/** The snapshot a resumed session recorded earlier, if any. */
export function recordedResidentSnapshot(entries: readonly SessionEntryLike[]): ResidentSnapshot | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== "custom" || entry.customType !== RESIDENT_ENTRY_TYPE) continue
    const data = entry.data
    if (data !== null && typeof data === "object" && typeof Reflect.get(data, "block") === "string") {
      return { block: withoutUserSection(Reflect.get(data, "block") as string) }
    }
  }
  return undefined
}

/**
 * A recorded block without the legacy `<user>` section. The block was written as `<memory>`, the user
 * section, a blank line, the soul section; the cut runs from the user tag to where that soul section
 * starts, so the profile text goes whole. A block with no soul section after it has nothing left.
 */
export function withoutUserSection(block: string): string {
  const opening = /^<memory>\s*<user[\s>]/.exec(block)
  if (opening === null) return block
  const start = opening[0].lastIndexOf("<user")
  const seam = "\n</user>\n\n<soul"
  const soul = block.indexOf(seam, start)
  if (soul < 0) return ""
  return `${block.slice(0, start)}${block.slice(soul + seam.length - "<soul".length)}`
}

/** Appends the snapshot to a composed system prompt; idempotent. */
export function withResidentBlock(systemPrompt: string, snapshot: ResidentSnapshot | undefined): string | undefined {
  if (snapshot === undefined || snapshot.block === "") return undefined
  if (systemPrompt.includes(snapshot.block)) return undefined
  return `${systemPrompt.trimEnd()}\n\n${snapshot.block}`
}

/** Creates the self store (one empty commit) when it is missing, so the GUI and the dream have a repo to edit. */
export async function ensureSelfRepo(memoryRoot: string): Promise<void> {
  const dir = selfRepoPath(memoryRoot)
  if (existsSync(join(dir, ".git"))) return
  await new GitMemoryRepo({ dir, agentId: "self" }).init({ authorName: "Rubato" })
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return ""
  }
}
