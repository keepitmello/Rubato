import { describe, expect, it } from "bun:test"
import { compileMemoryBlock } from "./compile"
import { memory, parseCompiledBlock, repoWith } from "./compile.test-support"

// The whitelist is the only way a committed system/ file rides in the prompt.
// Empty/unset is the retrieve-on-demand deployment: repository and tools stay
// live, nothing from system/ is inlined, and the names-only external tree is gone.
const fixture = [
  { relativePath: "system/persona.md", content: memory("PERSONA_DESCRIPTION", "PERSONA_BODY_SENTINEL\n") },
  { relativePath: "system/identity.md", content: memory("IDENTITY_DESCRIPTION", "IDENTITY_BODY_SENTINEL\n") },
  { relativePath: "system/human.md", content: memory("HUMAN_DESCRIPTION", "HUMAN_BODY_SENTINEL\n") },
  { relativePath: "system/soul.md", content: memory("SOUL_DESCRIPTION", "SOUL_BODY_SENTINEL\n") },
  { relativePath: "system/human/prefs/coding.md", content: memory("PREFS_DESCRIPTION", "PREFS_BODY_SENTINEL\n") },
  { relativePath: "reference/details.md", content: memory("REFERENCE_DESCRIPTION", "EXTERNAL_BODY_SENTINEL\n") },
]

describe("compileMemoryBlock project whitelist", () => {
  it("#given committed memory of every kind #when compiled with an empty whitelist #then only structured metadata remains", async () => {
    // given
    const { repo } = await repoWith(fixture)

    // when
    const block = await compileMemoryBlock(repo, { agentId: "agent-golden", project: [] })
    const structure = parseCompiledBlock(block)

    // then
    expect(structure).toEqual({
      sections: ["memory_metadata"],
      projectionPaths: [],
      memoryOpenTags: [],
      metadata: { agentId: "agent-golden" },
    })
  }, 30_000)

  it("#given committed memory #when compiled with project omitted #then it matches the empty whitelist", async () => {
    // given: unset is the same as [] so a machine that pulls without editing config
    // lands on metadata-only, not the historical "project everything" default.
    const { repo } = await repoWith(fixture)

    // when
    const omitted = await compileMemoryBlock(repo, { agentId: "agent-golden" })
    const empty = await compileMemoryBlock(repo, { agentId: "agent-golden", project: [] })

    // then
    expect(omitted).toBe(empty)
    expect(omitted).toContain("- AGENT_ID: agent-golden")
    expect(omitted).not.toContain("Reminder:")
    expect(omitted).not.toContain("<external_projection>")
    expect(omitted).not.toContain("SOUL_BODY_SENTINEL")
  }, 30_000)

  it("#given committed memory #when compiled with an empty whitelist #then no body, reminder, or external path leaks", async () => {
    // given
    const { repo } = await repoWith(fixture)

    // when
    const block = await compileMemoryBlock(repo, { agentId: "agent-golden", project: [] })

    // then
    for (const sentinel of [
      "PERSONA_BODY_SENTINEL",
      "IDENTITY_BODY_SENTINEL",
      "HUMAN_BODY_SENTINEL",
      "SOUL_BODY_SENTINEL",
      "PREFS_BODY_SENTINEL",
      "EXTERNAL_BODY_SENTINEL",
      "PERSONA_DESCRIPTION",
      "HUMAN_DESCRIPTION",
      "REFERENCE_DESCRIPTION",
    ]) {
      expect(block).not.toContain(sentinel)
    }
    expect(block).not.toContain("reference/details.md")
    expect(block).not.toContain("<external_projection>")
    expect(block).not.toContain("$MEMORY_DIR")
    expect(block).not.toContain("Reminder:")
    expect(block).toContain("- AGENT_ID: agent-golden")
  }, 30_000)

  it("#given a listed system file #when compiled #then that file is projected and unlisted system files are not", async () => {
    // given: later adding system/soul.md is a two-line config change.
    const { repo } = await repoWith(fixture)

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "agent-golden",
      project: ["system/soul.md"],
    })

    // then
    expect(block).toContain("SOUL_BODY_SENTINEL")
    expect(block).toContain("Reminder:")
    expect(block).toContain("<memory>")
    expect(block).not.toContain("PERSONA_BODY_SENTINEL")
    expect(block).not.toContain("HUMAN_BODY_SENTINEL")
    expect(block).not.toContain("<self>")
    expect(block).not.toContain("<external_projection>")
    expect(block).not.toContain("EXTERNAL_BODY_SENTINEL")
    expect(block).toContain("- AGENT_ID: agent-golden")
  }, 30_000)

  it("#given a listed persona #when compiled #then it renders under self without bringing unlisted files or the external tree", async () => {
    // given
    const { repo } = await repoWith(fixture)

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "agent-golden",
      project: ["system/persona.md"],
    })

    // then
    expect(block).toContain("PERSONA_BODY_SENTINEL")
    expect(block).toContain("<self>")
    expect(block).not.toContain("SOUL_BODY_SENTINEL")
    expect(block).not.toContain("<external_projection>")
    expect(block).not.toContain("reference/details.md")
  }, 30_000)

  it("#given non-system paths in the whitelist #when compiled #then they are ignored and nothing is projected", async () => {
    // given
    const { repo } = await repoWith(fixture)

    // when
    const block = await compileMemoryBlock(repo, {
      agentId: "agent-golden",
      project: ["reference/details.md", "skills/deploy/SKILL.md"],
    })

    // then
    expect(parseCompiledBlock(block).sections).toEqual(["memory_metadata"])
    expect(block).not.toContain("EXTERNAL_BODY_SENTINEL")
    expect(block).not.toContain("Reminder:")
  }, 30_000)

  it("#given an empty whitelist #when compiled #then the repository tree is never read", async () => {
    // given: the cut point is an early return, not a read-then-discard.
    const { repo } = await repoWith(fixture)
    const calls: string[] = []
    const recording = Object.create(repo) as typeof repo
    recording.lsTree = async (revision, path) => {
      calls.push("lsTree")
      return repo.lsTree(revision, path)
    }
    recording.show = async (revision, path) => {
      calls.push("show")
      return repo.show(revision, path)
    }

    // when
    await compileMemoryBlock(recording, { agentId: "agent-golden", project: [] })

    // then
    expect(calls).toEqual([])

    // and: the same double does record reads when a path is listed, so an inert
    // double cannot make the assertion above pass vacuously.
    await compileMemoryBlock(recording, { agentId: "agent-golden", project: ["system/soul.md"] })
    expect(calls).toContain("lsTree")
    expect(calls).toContain("show")
  }, 30_000)
})
