/**
 * Default memory seeding.
 *
 * Fresh memory repos receive only the memory-discipline skill. system/persona.md
 * and system/human.md are no longer seeded — their replacement is a later
 * soul/user design that does not exist yet. If the repo already has a HEAD
 * commit, GitMemoryRepo.init returns the existing HEAD unchanged, so this
 * module never overwrites an existing tree.
 */

import type { GitMemoryRepo, GitSeedFile } from "../git"
import {
  MEMORY_DISCIPLINE_SKILL_CONTENT,
  MEMORY_DISCIPLINE_SKILL_PATH,
} from "./memory-discipline"

export { DEFAULT_MEMORY_BLOCK_LABELS } from "./default-memory"

export interface DefaultSeedFile extends GitSeedFile {}

export interface InitMemorySeedsOptions {
  authorName?: string
}

/**
 * Build the default seed files: the memory-discipline skill only.
 *
 * Pure — no filesystem access. Safe to call repeatedly.
 */
export function buildDefaultSeedFiles(): readonly DefaultSeedFile[] {
  return [
    {
      relativePath: MEMORY_DISCIPLINE_SKILL_PATH,
      content: MEMORY_DISCIPLINE_SKILL_CONTENT,
    },
  ]
}

/**
 * Initialize a memory repo with default seed content.
 *
 * Delegates to GitMemoryRepo.init with the default seed files. The
 * no-overwrite guard (existing HEAD -> immediate return) is enforced
 * inside GitMemoryRepo.init, so calling this on an already-initialized
 * repo is a safe no-op.
 *
 * Returns the HEAD sha after initialization.
 */
export async function initMemoryWithSeeds(
  repo: GitMemoryRepo,
  options: InitMemorySeedsOptions = {},
): Promise<string> {
  return repo.init({
    authorName: options.authorName,
    seedFiles: buildDefaultSeedFiles(),
  })
}
