import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { BeforeAgentStartEventResult } from "@code-yeongyu/senpi"
import {
  GitMemoryRepo,
  buildIdentityPaths,
  consumeSoulNoticeDelta,
} from "@rubato/memory-core"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createMemoryBinding } from "./binding"
import { createMemoryIdentityContext, type MemoryIdentityContext } from "./context"
import {
  MEMORY_COMPACT_PRIORITY_TOKEN,
  MEMORY_NUDGE_METADATA_TOKEN,
  MEMORY_PRESSURE_METADATA_TOKEN,
  MEMORY_PROMPT_TEMPLATE,
  MEMORY_SOUL_METADATA_TOKEN,
  createMemoryPromptHandler,
} from "./prompt"
import { MEMORY_PRESSURE_SOFT_RATIO } from "./status"
import { realpathSync } from "node:fs"
import { rmEfaultTolerant } from "./teardown.test-support"

const IDENTITY = "prompt-agent"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rmEfaultTolerant(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

class CountingRepo extends GitMemoryRepo {
  headCalls = 0
  lsTreeCalls = 0
  showCalls = 0

  override async head(): Promise<string | null> {
    this.headCalls += 1
    return super.head()
  }

  override async lsTree(revision?: string, path?: string): Promise<string[]> {
    this.lsTreeCalls += 1
    return super.lsTree(revision, path)
  }

  override async show(revision: string, path: string): Promise<string> {
    this.showCalls += 1
    return super.show(revision, path)
  }

  resetCounts(): void {
    this.headCalls = 0
    this.lsTreeCalls = 0
    this.showCalls = 0
  }
}

async function fixture(personaBody = "first"): Promise<{ repo: CountingRepo; context: MemoryIdentityContext }> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-prompt-")))
  tempDirs.push(dir)
  const repo = new CountingRepo({ dir: join(dir, "repo"), agentId: IDENTITY })
  await repo.init({
    seedFiles: [{ relativePath: "system/persona.md", content: `---\ndescription: Persona\n---\n${personaBody}\n` }],
  })
  repo.resetCounts()
  const context = createMemoryIdentityContext({
    identity: IDENTITY,
    identityPaths: buildIdentityPaths(join(dir, "memory"), IDENTITY),
    binding: createMemoryBinding({ identity: IDENTITY, repoPath: repo.dir, boundAt: 0 }),
  })
  return { repo, context }
}

async function fixtureAtSystemTokens(tokens: number): Promise<{ repo: CountingRepo; context: MemoryIdentityContext }> {
  const header = "---\ndescription: Persona\n---\n"
  return fixture("A".repeat(tokens * 4 - Buffer.byteLength(header, "utf8") - 1))
}

function eventContext(sessionId: string): unknown {
  return { sessionManager: { getSessionId: () => sessionId } }
}

function beforeAgentStart(systemPrompt: string): unknown {
  return { type: "before_agent_start", prompt: "hello", systemPrompt }
}

// One prompted turn as the host runs it: the session prompt is composed on `system_prompt`,
// then `before_agent_start` delivers the turn's late notices.
async function dispatchEvent(
  pi: FakeExtensionAPI,
  payload: unknown,
  ctx: unknown,
): Promise<BeforeAgentStartEventResult | undefined> {
  const [composed] = await pi.dispatch("system_prompt", { ...(payload as object), type: "system_prompt" }, ctx)
  const [started] = await pi.dispatch("before_agent_start", payload, ctx)
  const systemPrompt = (composed as BeforeAgentStartEventResult | undefined)?.systemPrompt
  const message = (started as BeforeAgentStartEventResult | undefined)?.message
  if (systemPrompt === undefined && message === undefined) return undefined
  return { ...(systemPrompt === undefined ? {} : { systemPrompt }), ...(message === undefined ? {} : { message }) }
}

function onPromptTurn(pi: FakeExtensionAPI, handler: (payload: unknown, ctx?: unknown) => unknown): void {
  pi.on("system_prompt", handler)
  pi.on("before_agent_start", handler)
}

function boundHandler(repo: CountingRepo, context: MemoryIdentityContext) {
  return createMemoryPromptHandler({
    resolveContext: () => context,
    createRepo: () => repo,
    resolveProject: () => ["system/persona.md"],
  })
}

describe("MEMORY_PROMPT_TEMPLATE", () => {
  test("#given the compiled-block cache key #when the template id is read #then it is the v3 stable template", () => {
    expect(MEMORY_PROMPT_TEMPLATE).toBe("rubato-runtime:before_agent_start:v3")
  }, 30_000)
})

describe("createMemoryPromptHandler", () => {
  test("#given an unbound or disabled session #when before_agent_start dispatches #then the handler returns undefined and never touches the repo", async () => {
    // given
    const { repo } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({ resolveContext: () => undefined, createRepo: () => repo }))

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(result).toBeUndefined()
    expect(repo.headCalls).toBe(0)
  }, 30_000)

  test("#given an event context without a session manager #when before_agent_start dispatches #then the handler returns undefined", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, boundHandler(repo, context))

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), {})

    // then
    expect(result).toBeUndefined()
    expect(repo.headCalls).toBe(0)
  }, 30_000)

  test("#given a bound identity #when before_agent_start dispatches #then the prompt gains a stable sentinel block and no late notice rides along", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, boundHandler(repo, context))

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(result?.systemPrompt).toContain("BASE PROMPT")
    expect(result?.systemPrompt).toContain(`<!-- senpi-memory:${IDENTITY}:begin -->`)
    expect(result?.systemPrompt).toContain(`<!-- senpi-memory:${IDENTITY}:end -->`)
    expect(result?.systemPrompt).toContain("first")
    expect(result?.systemPrompt).toContain(`- AGENT_ID: ${IDENTITY}`)
    expect(result?.systemPrompt).not.toContain("CONVERSATION_ID")
    expect(result?.message).toBeUndefined()
  }, 30_000)

  test("#given quiet turns #when a nudge becomes due #then only that turn carries the notice", async () => {
    // given
    const { repo, context } = await fixture()
    let turns: number | undefined
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveNudgeTurns: async () => turns,
    }))

    // when
    const first = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    const quiet = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    turns = 12
    const nudged = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(first?.message).toBeUndefined()
    expect(quiet?.message).toBeUndefined()
    expect(nudged?.message).toMatchObject({ customType: "rubato-memory:notice", display: false })
    expect(nudged?.message?.content).toContain(MEMORY_NUDGE_METADATA_TOKEN)
  }, 30_000)

  test("#given the same identity and HEAD across sessions and turns #when volatile notices change #then the system block stays byte-identical and notices travel as a late message", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveNudgeTurns: async (_repo, sessionId) => sessionId === "session-after-threshold" ? 12 : undefined,
      resolveSoulNotice: async (_repo, sessionId) => sessionId === "session-after-threshold"
        ? { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" }
        : undefined,
    }))

    // when
    const beforeThreshold = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-before-threshold"))
    const afterThreshold = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-after-threshold"))

    // then
    expect(afterThreshold?.systemPrompt).toBe(beforeThreshold?.systemPrompt)
    expect(beforeThreshold?.message).toBeUndefined()
    expect(afterThreshold?.message).toMatchObject({
      customType: "rubato-memory:notice",
      display: false,
    })
    expect(afterThreshold?.message?.content).toContain(MEMORY_NUDGE_METADATA_TOKEN)
    expect(afterThreshold?.message?.content).toContain(MEMORY_SOUL_METADATA_TOKEN)
  }, 30_000)

  test("#given committed system memory below the soft threshold #when before_agent_start compiles #then the block stays byte-identical to the pre-pressure format", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveCompileWarnTokens: () => 30_000,
      resolveProject: () => ["system/persona.md"],
    }))

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(result?.systemPrompt).toBe([
      "BASE PROMPT",
      "",
      `<!-- senpi-memory:${IDENTITY}:begin -->`,
      "Reminder: <projection> holds local paths of memory projections. <memory> is your persistent memory across conversations. Consult it BEFORE asking the user anything it may already answer. Save durable facts, preferences, decisions, and corrections with the memory tools when they emerge — but never instead of answering a direct user question or request.",
      "",
      "<self>",
      "<projection>$MEMORY_DIR/system/persona.md</projection>",
      "first",
      "</self>",
      "",
      "<memory_metadata>",
      `- AGENT_ID: ${IDENTITY}`,
      "</memory_metadata>",
      `<!-- senpi-memory:${IDENTITY}:end -->`,
    ].join("\n"))
    expect(result?.systemPrompt).not.toContain(MEMORY_PRESSURE_METADATA_TOKEN)
  }, 30_000)

  test("#given committed system memory exactly at floor eighty percent of the advisory #when before_agent_start compiles #then one actionable pressure line carries N M and P", async () => {
    // given
    const advisory = 30_000
    const boundary = Math.floor(MEMORY_PRESSURE_SOFT_RATIO * advisory)
    const { repo, context } = await fixtureAtSystemTokens(boundary)
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveCompileWarnTokens: () => advisory,
      resolveProject: () => ["system/persona.md"],
    }))

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(boundary).toBe(24_000)
    const pressureLines = result?.systemPrompt?.split("\n").filter((line) => line.includes(MEMORY_PRESSURE_METADATA_TOKEN)) ?? []
    expect(pressureLines).toHaveLength(1)
    expect(pressureLines[0]).toContain("24000/30000")
    expect(pressureLines[0]).toContain("80%")
    expect(pressureLines[0]).toMatch(/trim|demote/)
    expect(result?.systemPrompt).toContain("A".repeat(1_000))
  }, 30_000)

  test("#given nudge state at the threshold #when before_agent_start compiles #then the late message carries the behavioral nudge token", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveNudgeTurns: async () => 2,
    }))

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(result?.systemPrompt).not.toContain(MEMORY_NUDGE_METADATA_TOKEN)
    expect(result?.message?.content).toContain(MEMORY_NUDGE_METADATA_TOKEN)
    expect(result?.message?.content).toMatch(/- 2 user turns since/)
    expect(result?.message?.content).toContain("answer or act on it first")
    expect(result?.message?.content).not.toContain("Save durable facts now")
  }, 30_000)

  test("#given a pending compact-priority notice #when before_agent_start compiles #then the late message leads with the answer-first guard once", async () => {
    // given
    const { repo, context } = await fixture()
    let pending = true
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveCompactPriorityNotice: () => {
        if (!pending) return false
        pending = false
        return true
      },
    }))

    // when
    const first = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    const second = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(first?.message?.content).toContain(MEMORY_COMPACT_PRIORITY_TOKEN)
    expect(first?.message?.content).toContain("latest user message is the primary task")
    expect(first?.systemPrompt).not.toContain(MEMORY_COMPACT_PRIORITY_TOKEN)
    // second turn: compact guard consumed; recall already sent on first, so no message
    expect(second?.message).toBeUndefined()
  }, 30_000)

  test("#given a reflection soul notice #when before_agent_start compiles #then the late message carries the soul token and short sha", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveSoulNotice: async () => ({ sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" }),
    }))

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(result?.systemPrompt).not.toContain(MEMORY_SOUL_METADATA_TOKEN)
    expect(result?.message?.content).toContain(MEMORY_SOUL_METADATA_TOKEN)
    expect(result?.message?.content).toMatch(/- Soul updated by reflection a1b2c3d /)
  }, 30_000)

  test("#given an out-of-band soul commit #when the prompt compiles repeatedly at the same HEAD #then the soul line appears exactly once", async () => {
    // given
    const { repo, context } = await fixture()
    const watermark = {
      noticesDir: context.identityPaths.notices,
      locksDir: context.identityPaths.locks,
    }
    expect(await consumeSoulNoticeDelta(repo, watermark)).toBeUndefined()
    await writeFile(join(repo.dir, "system/persona.md"), "---\ndescription: Persona\n---\nevolved\n")
    await repo.commitWrite(
      ["system/persona.md"],
      "chore(reflection): merge run r1\n\nRubato-Writer: reflection",
      { agentId: IDENTITY, authorName: "Prompt Agent" },
    )
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveSoulNotice: (repoArg) => consumeSoulNoticeDelta(repoArg, watermark),
    }))

    // when
    const first = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    const second = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    const third = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(first?.message?.content).toContain(MEMORY_SOUL_METADATA_TOKEN)
    // Later turns carry no notice at all: the soul delta was already consumed, so nothing volatile
    // is left to say.
    expect(second?.message?.content ?? "").not.toContain(MEMORY_SOUL_METADATA_TOKEN)
    expect(third?.message?.content ?? "").not.toContain(MEMORY_SOUL_METADATA_TOKEN)
    expect(second?.systemPrompt).toBe(first?.systemPrompt)
    expect(third?.systemPrompt).toBe(first?.systemPrompt)
  }, 30_000)

  test("#given another extension already rewrote the system prompt #when the handler runs #then the foreign text survives and the block is appended", async () => {
    // given
    const { repo, context } = await fixture()
    const foreignPi = new FakeExtensionAPI()
    foreignPi.on("before_agent_start", () => ({ systemPrompt: "BASE PROMPT\n\nFOREIGN EXTENSION TEXT" }))
    const memoryPi = new FakeExtensionAPI()
    onPromptTurn(memoryPi, boundHandler(repo, context))

    // when — mirror the host runner: the next handler receives the previous handler's prompt
    const [foreign] = await foreignPi.dispatch("before_agent_start", beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    const foreignPrompt = (foreign as BeforeAgentStartEventResult).systemPrompt ?? ""
    const result = await dispatchEvent(memoryPi, beforeAgentStart(foreignPrompt), eventContext("session-1"))

    // then
    expect(result?.systemPrompt).toContain("FOREIGN EXTENSION TEXT")
    expect(result?.systemPrompt).toContain("BASE PROMPT")
    expect(result?.systemPrompt).toContain(`<!-- senpi-memory:${IDENTITY}:begin -->`)
  }, 30_000)

  test("#given an unchanged HEAD #when the handler runs twice #then HEAD is re-checked each run while the block compiles once", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, boundHandler(repo, context))

    // when
    const first = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    const second = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(second?.systemPrompt).toBe(first?.systemPrompt)
    expect(repo.headCalls).toBe(2)
    expect(repo.lsTreeCalls).toBe(1)
    expect(repo.showCalls).toBe(1)
  }, 30_000)

  test("#given a commit between runs #when the next dispatch happens #then the new content appears while the prior result keeps the old content", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, boundHandler(repo, context))
    const first = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    expect(repo.headCalls).toBe(1)

    // when
    await writeFile(join(repo.dir, "system/persona.md"), "---\ndescription: Persona\n---\nsecond\n")
    await repo.commitWrite(["system/persona.md"], "update persona", { agentId: IDENTITY, authorName: "Prompt Agent" })
    const headCallsAfterCommit = repo.headCalls
    const second = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(first?.systemPrompt).toContain("first")
    expect(first?.systemPrompt).not.toContain("second")
    expect(second?.systemPrompt).toContain("second")
    expect(repo.headCalls - headCallsAfterCommit).toBe(1)
    expect(repo.lsTreeCalls).toBe(2)
  }, 30_000)

  test("#given a prompt already carrying our sentinel block #when the handler runs #then the block is replaced, not duplicated", async () => {
    // given
    const { repo, context } = await fixture()
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, boundHandler(repo, context))
    const first = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // when — the host carries last turn's prompt forward with our block inside
    const second = await dispatchEvent(pi, beforeAgentStart(first?.systemPrompt ?? ""), eventContext("session-1"))

    // then
    expect(second?.systemPrompt?.match(new RegExp(`<!-- senpi-memory:${IDENTITY}:begin -->`, "g"))).toHaveLength(1)
    expect(second?.systemPrompt?.match(new RegExp(`<!-- senpi-memory:${IDENTITY}:end -->`, "g"))).toHaveLength(1)
    expect(second?.systemPrompt).toContain("BASE PROMPT")
  }, 30_000)

  test("#given an empty project whitelist #when before_agent_start dispatches #then the sentinel block carries metadata only and no persona body", async () => {
    // given
    const { repo, context } = await fixture("PERSONA_BODY_SENTINEL")
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
        resolveContext: () => context,
        createRepo: () => repo,
        resolveProject: () => [],
      }),
    )

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    const prompt = result?.systemPrompt ?? ""
    expect(prompt).toContain("BASE PROMPT")
    expect(prompt).toContain(`<!-- senpi-memory:${IDENTITY}:begin -->`)
    expect(prompt).toContain("- AGENT_ID: ")
    expect(prompt).not.toContain("PERSONA_BODY_SENTINEL")
    expect(prompt).not.toContain("<self>")
    expect(prompt).not.toContain("Reminder:")
  }, 30_000)

  test("#given an empty whitelist on a repository over the pressure advisory #when dispatched #then no pressure line is emitted", async () => {
    // given: pressure advises trimming system/ because it is expensive every turn; with nothing
    // projected that cost is not paid, so the advice would point at a bill nobody receives.
    const warnTokens = 100
    const { repo, context } = await fixtureAtSystemTokens(Math.ceil(warnTokens * MEMORY_PRESSURE_SOFT_RATIO) + 10)
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, createMemoryPromptHandler({
        resolveContext: () => context,
        createRepo: () => repo,
        resolveCompileWarnTokens: () => warnTokens,
        resolveProject: () => [],
      }),
    )

    // when
    const result = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))

    // then
    expect(result?.systemPrompt ?? "").not.toContain(MEMORY_PRESSURE_METADATA_TOKEN)
  }, 30_000)

  test("#given the project whitelist changed between runs #when dispatched twice #then the cache does not serve the other variant", async () => {
    // given: one cache instance, one identity, one HEAD - only the whitelist differs, so a cache key
    // that ignored it would hand the second run the first run's block.
    const { repo, context } = await fixture("PERSONA_BODY_SENTINEL")
    let project: readonly string[] = ["system/persona.md"]
    const handler = createMemoryPromptHandler({
      resolveContext: () => context,
      createRepo: () => repo,
      resolveProject: () => project,
    })
    const pi = new FakeExtensionAPI()
    onPromptTurn(pi, handler)

    // when
    const on = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-1"))
    project = []
    const off = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-2"))
    project = ["system/persona.md"]
    const backOn = await dispatchEvent(pi, beforeAgentStart("BASE PROMPT"), eventContext("session-3"))

    // then
    expect(on?.systemPrompt ?? "").toContain("PERSONA_BODY_SENTINEL")
    expect(off?.systemPrompt ?? "").not.toContain("PERSONA_BODY_SENTINEL")
    expect(backOn?.systemPrompt ?? "").toContain("PERSONA_BODY_SENTINEL")
  }, 30_000)

})
