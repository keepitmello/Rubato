import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { GitMemoryRepo } from "../git"
import { parseMemoryFile } from "../memfs/frontmatter"
import { compileMemoryBlock } from "../compile"
import {
  DEFAULT_MEMORY_BLOCK_LABELS,
  buildDefaultSeedFiles,
  initMemoryWithSeeds,
} from "./seeds"
import { MEMORY_DISCIPLINE_SKILL_PATH } from "./memory-discipline"
import { realpathSync } from "node:fs"

const exec = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function createRepo(agentId = "seed-agent"): Promise<{ dir: string; repo: GitMemoryRepo }> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "rubato-seeds-")))
  tempDirs.push(dir)
  return { dir, repo: new GitMemoryRepo({ dir, agentId }) }
}

async function gitLog(dir: string, format: string): Promise<string> {
  const result = await exec("git", ["log", `--format=${format}`], { cwd: dir })
  return result.stdout.trim()
}

describe("default memory seeds", () => {
  describe("#given the default block label constants", () => {
    it("#then they are empty: persona and human are no longer seeded", () => {
      expect(DEFAULT_MEMORY_BLOCK_LABELS).toEqual([])
    })
  })

  describe("#given buildDefaultSeedFiles", () => {
    it("#then it produces only the memory-discipline skill", () => {
      const files = buildDefaultSeedFiles()

      expect(files).toHaveLength(1)
      expect(files[0]?.relativePath).toBe("skills/memory-discipline/SKILL.md")
      expect(files.map((f) => f.relativePath)).not.toContain("system/persona.md")
      expect(files.map((f) => f.relativePath)).not.toContain("system/human.md")
    })

    it("#then the memory-discipline skill seed path is skills/memory-discipline/SKILL.md", () => {
      expect(MEMORY_DISCIPLINE_SKILL_PATH).toBe("skills/memory-discipline/SKILL.md")
    })

    it("#then every seed file parses as a memory file", () => {
      const files = buildDefaultSeedFiles()

      for (const file of files) {
        expect(() => parseMemoryFile(file.content)).not.toThrow()
      }
    })
  })

  it("#given a fresh repository #when initMemoryWithSeeds runs #then it commits the discipline skill in one initial commit", async () => {
    // given
    const { dir, repo } = await createRepo()

    // when
    const sha = await initMemoryWithSeeds(repo, { authorName: "Seed Test Agent" })

    // then
    expect(sha).toMatch(/^[0-9a-f]{40,64}$/)

    const tree = await repo.lsTree()
    expect(tree).toEqual(["skills/memory-discipline/SKILL.md"])
    expect(tree).not.toContain("system/persona.md")
    expect(tree).not.toContain("system/human.md")

    const commitSubject = await gitLog(dir, "%s")
    expect(commitSubject).toBe("chore: initialize local memory")

    const commitLines = (await gitLog(dir, "oneline")).split("\n").filter(Boolean)
    expect(commitLines).toHaveLength(1)
  })

  it("#given a fresh repository #when initMemoryWithSeeds runs without authorName #then it uses the default agent name", async () => {
    // given
    const { repo } = await createRepo()

    // when
    const sha = await initMemoryWithSeeds(repo)

    // then
    expect(sha).toMatch(/^[0-9a-f]{40,64}$/)
  })

  it("#given an existing repo with commits #when initMemoryWithSeeds runs #then it is a no-op (HEAD unchanged)", async () => {
    // given
    const { dir, repo } = await createRepo()
    const originalHead = await initMemoryWithSeeds(repo, { authorName: "First Agent" })
    await writeFile(join(dir, "notes.md"), "---\ndescription: x\n---\nCustom\n")
    await repo.commitWrite(["notes.md"], "user edit", {
      agentId: "seed-agent",
      authorName: "User",
    })
    const headBefore = await repo.head()

    // when
    const result = await initMemoryWithSeeds(repo, { authorName: "Second Agent" })

    // then
    expect(await repo.head()).toBe(headBefore)
    expect(await repo.head()).toBe(result)
    expect(result).not.toBe(originalHead)

    const notes = await repo.show("HEAD", "notes.md")
    expect(notes).toContain("Custom")
  })

  it("#given seeded content #when compiled via the memory compiler #then nothing from the seed is projected", async () => {
    // given: the discipline skill lives under skills/ and is never inlined.
    const { repo } = await createRepo()

    // when
    await initMemoryWithSeeds(repo, { authorName: "Compiler Agent" })
    const block = await compileMemoryBlock(repo, { agentId: "seed-agent" })

    // then
    expect(block).not.toContain("<self>")
    expect(block).not.toContain("<memory>")
    expect(block).toContain("<memory_metadata>")
    expect(block).toContain("- AGENT_ID: seed-agent")
  })
})
