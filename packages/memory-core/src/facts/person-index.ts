import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { parseMemoryFile } from "../memfs"

export interface FactsPeopleIndexEntry {
  readonly slug: string
  readonly displayName: string
  readonly names: readonly string[]
}

/**
 * The primary human's slug. Reserved unconditionally.
 *
 * It used to be reserved only when `system/human.md` existed, because that file was
 * always seeded. Once it stopped being seeded, a fresh repository reserved nothing:
 * a fact about the primary user was routed as a brand-new person, written to
 * `people/human/card.md` — and then never found again, because the directory scan
 * below skips that name. Every later batch re-created it as new. The reservation has
 * to stand on its own, not on the presence of a file.
 */
export const PRIMARY_HUMAN_SLUG = "human"

export async function readFactsPeopleIndex(repoDir: string): Promise<FactsPeopleIndexEntry[]> {
  const index: FactsPeopleIndexEntry[] = []
  // Two possible homes for the primary card, oldest first. `system/human.md` is the
  // legacy seat and still wins when a repository has one; `people/human/card.md` is
  // where a repository seeded after the change keeps it. Reading both means an
  // existing repository keeps working and a fresh one has somewhere to land.
  const human = await readCardFrontmatter(join(repoDir, "system", "human.md"))
    ?? await readCardFrontmatter(join(repoDir, "people", PRIMARY_HUMAN_SLUG, "card.md"))
  index.push({
    slug: PRIMARY_HUMAN_SLUG,
    displayName: displayNameOf(human?.description, PRIMARY_HUMAN_SLUG),
    names: namesOf(human, PRIMARY_HUMAN_SLUG),
  })
  const entries = await readdir(join(repoDir, "people"), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === PRIMARY_HUMAN_SLUG) continue
    const card = await readCardFrontmatter(join(repoDir, "people", entry.name, "card.md"))
    if (card === undefined) continue
    index.push({
      slug: entry.name,
      displayName: displayNameOf(card.description, entry.name),
      names: namesOf(card, entry.name),
    })
  }
  return index
}

async function readCardFrontmatter(
  path: string,
): Promise<{ readonly description: string; readonly aliases: readonly string[] } | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    const parsed = parseMemoryFile(raw)
    return { description: parsed.frontmatter.description, aliases: parsed.frontmatter.aliases ?? [] }
  } catch {
    return undefined
  }
}

// The primary human is reserved even when no card exists yet, so both helpers have to
// tolerate an absent one and fall back to the slug.
function namesOf(
  card: { readonly description?: string; readonly aliases?: readonly string[] } | undefined,
  fallback: string,
): readonly string[] {
  return [displayNameOf(card?.description, fallback), ...(card?.aliases ?? [])]
}

function displayNameOf(description: string | undefined, fallback: string): string {
  return (description ?? "").replace(/^Person\s*-\s*/i, "").trim() || fallback
}
