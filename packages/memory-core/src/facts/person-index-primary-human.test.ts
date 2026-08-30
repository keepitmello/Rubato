import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo } from "../git"
import { buildDefaultSeedFiles } from "../seeds"
import { PRIMARY_HUMAN_SLUG, readFactsPeopleIndex } from "./person-index"
import { factsRoutingPaths, planFactsRouting } from "./person-routing"

// The primary human's slug used to be reserved only when `system/human.md` existed.
// That file was always seeded, so the coupling was invisible until the seed was
// removed — then a fresh repository reserved nothing, routed the primary user as a
// brand-new person into `people/human/card.md`, and never found that card again
// because the directory scan skips that name. Every later batch re-created it.
//
// These tests pin the reservation itself, independent of any file being present.

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function repoWithout(): Promise<GitMemoryRepo> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "primary-human-")))
  tempDirs.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: "primary-human" })
  await repo.init({ seedFiles: buildDefaultSeedFiles() })
  return repo
}

const PERSON_RECORD = {
  scope: "person",
  person: { name: "human", aliases: [] as string[] },
  text: "prefers Korean",
  date: "2026-08-25",
}

const PEOPLE = { enabled: true, limits: { maxEntries: 40, maxEntryChars: 200 } }

describe("primary human reservation", () => {
  test("#given a freshly seeded repository #when the index is read #then the primary slug is reserved without any card", async () => {
    const repo = await repoWithout()

    const index = await readFactsPeopleIndex(repo.dir)

    expect(index.map((entry) => entry.slug)).toContain(PRIMARY_HUMAN_SLUG)
  }, 30_000)

  test("#given no primary card #when a fact about the primary human is routed #then it is not treated as a new person", async () => {
    // The regression: isNew true here means a card gets written to a path the index
    // deliberately skips, so it is invisible on the next run.
    const repo = await repoWithout()

    const plan = await planFactsRouting(repo.dir, [PERSON_RECORD as never], PEOPLE as never)

    const targets = [...plan.observations.values()].map((bucket) => bucket.target)
    expect(targets.map((target) => target.slug)).toEqual([PRIMARY_HUMAN_SLUG])
    expect(targets.map((target) => target.isNew)).toEqual([false])
    expect(factsRoutingPaths(plan)).not.toContain(`people/${PRIMARY_HUMAN_SLUG}/card.md`)
  }, 30_000)

  test("#given routing runs twice #when the second batch arrives #then it resolves to the same slug rather than a collision suffix", async () => {
    // The visible symptom of the bug: `human`, then `human-2`, then `human-3`...
    const repo = await repoWithout()

    await planFactsRouting(repo.dir, [PERSON_RECORD as never], PEOPLE as never)
    const second = await planFactsRouting(repo.dir, [PERSON_RECORD as never], PEOPLE as never)

    expect([...second.observations.keys()]).toEqual([PRIMARY_HUMAN_SLUG])
  }, 30_000)

  test("#given a legacy system/human.md #when the index is read #then its identity still wins", async () => {
    const repo = await repoWithout()
    // A fresh repo no longer has system/ at all, so create it before planting the legacy file.
    await mkdir(join(repo.dir, "system"), { recursive: true })
    await writeFile(
      join(repo.dir, "system", "human.md"),
      "---\ndescription: Person - Legacy Name\nkind: person\naliases: [\"Nickname\"]\n---\nbody\n",
    )

    const index = await readFactsPeopleIndex(repo.dir)

    const primary = index.find((entry) => entry.slug === PRIMARY_HUMAN_SLUG)
    expect(primary?.displayName).toBe("Legacy Name")
    expect(primary?.names).toContain("Nickname")
  }, 30_000)

  test("#given a card at people/human #when the index is read #then that identity is used", async () => {
    // Where a repository seeded after the seed removal keeps the primary card.
    const repo = await repoWithout()
    await mkdir(join(repo.dir, "people", PRIMARY_HUMAN_SLUG), { recursive: true })
    await writeFile(
      join(repo.dir, "people", PRIMARY_HUMAN_SLUG, "card.md"),
      "---\ndescription: Person - New Home\nkind: person\naliases: [\"NH\"]\n---\nbody\n",
    )

    const index = await readFactsPeopleIndex(repo.dir)

    const primary = index.find((entry) => entry.slug === PRIMARY_HUMAN_SLUG)
    expect(primary?.displayName).toBe("New Home")
    expect(primary?.names).toContain("NH")
  }, 30_000)
})
