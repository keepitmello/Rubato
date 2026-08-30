import { describe, expect, it } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { compileMemoryBlock } from "./compile"
import { memory, parseCompiledBlock, repoWith } from "./compile.test-support"

describe("compileMemoryBlock", () => {
  it("#given a dirty persona edit #when compiled #then only the committed HEAD body sentinel appears", async () => {
    // given
    const { dir, repo } = await repoWith([
      { relativePath: "system/persona.md", content: memory("PERSONA", "COMMITTED_BODY_SENTINEL\n") },
    ])
    await writeFile(join(dir, "system/persona.md"), memory("PERSONA", "DIRTY_BODY_SENTINEL\n"))

    // when
    const block = await compileMemoryBlock(repo, { agentId: "persona-agent", project: ["system/persona.md"] })

    // then
    expect(block).toContain("COMMITTED_BODY_SENTINEL")
    expect(block).not.toContain("DIRTY_BODY_SENTINEL")
  })

  it("#given a committed binary projection #when compiled #then its path is listed without reading its blob", async () => {
    // given
    const { repo } = await repoWith([{ relativePath: "assets/logo.png", content: "BINARY_BODY_SENTINEL" }])
    const originalShow = repo.show.bind(repo)
    repo.show = async (revision, path) => {
      if (path.endsWith(".png")) throw new Error("binary blob was read")
      return originalShow(revision, path)
    }

    // when
    const block = await compileMemoryBlock(repo, { agentId: "binary-agent", project: ["system/persona.md"] })
    const structure = parseCompiledBlock(block)

    // then: binaries and other non-system paths never ride in the prompt, even as names.
    expect(structure.sections).toEqual(["memory_metadata"])
    expect(structure.memoryOpenTags).toEqual([])
    expect(block).not.toContain("logo.png")
    expect(block).not.toContain("<external_projection>")
    expect(block).not.toContain("BINARY_BODY_SENTINEL")
  })

  it("#given an unreadable committed system file #when compiled #then its structural tag is skipped best-effort", async () => {
    // given
    const { repo } = await repoWith([
      { relativePath: "system/persona.md", content: memory("PERSONA", "READABLE_BODY_SENTINEL\n") },
      { relativePath: "system/broken.md", content: "missing frontmatter" },
    ])

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "skip-agent",
      project: ["system/persona.md", "system/broken.md"],
    })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure.sections).toEqual(["self", "memory_metadata"])
    expect(structure.projectionPaths).toEqual(["system/persona.md"])
    expect(block).toContain("READABLE_BODY_SENTINEL")
  })
})
