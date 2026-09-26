import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitMemoryRepo } from "@rubato/memory-core"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { rmSyncEfaultTolerant } from "./teardown.test-support"
import { MEMORY_BINDING_CUSTOM_TYPE, createMemoryComponent } from "./index"
import { componentContext, loadedMemoryConfig, memorySettings, MemoryFakeExtensionAPI, sessionContext } from "./memory.test-support"
import { RESIDENT_ENTRY_TYPE } from "./prompt"
import { MEMORY_UNBOUND_MESSAGE } from "./tool-metadata"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSyncEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function fixture(): { cwd: string; memoryHome: string } {
  const root = mkdtempSync(join(tmpdir(), "rubato-memory-component-"))
  roots.push(root)
  const cwd = join(root, "project")
  mkdirSync(cwd, { recursive: true })
  return { cwd, memoryHome: join(root, "memory") }
}

function recordingLauncher() {
  const reasons: string[] = []
  return { reasons, launch: (reason: string) => (reasons.push(reason), true) }
}

function setup(options: { readonly agent?: string; readonly hasUI?: boolean; readonly git?: boolean } = {}) {
  const { cwd, memoryHome } = fixture()
  if (options.git === true) execFileSync("git", ["init", "-q"], { cwd })
  const pi = new MemoryFakeExtensionAPI()
  const dream = recordingLauncher()
  createMemoryComponent({
    env: { RUBATO_MEMORY_HOME: memoryHome },
    loadConfig: () => loadedMemoryConfig(memorySettings(options.agent === undefined ? {} : { agent: options.agent })),
    resolveCwd: () => cwd,
    now: () => 123,
    dreamLauncher: dream,
  }).register(pi, componentContext())
  const session = sessionContext({ hasUI: options.hasUI ?? true })
  return { cwd, memoryHome, pi, dream, session }
}

async function executeMemory(pi: MemoryFakeExtensionAPI, session: unknown, params: Record<string, unknown>) {
  const tool = pi.tools.find((candidate) => candidate.name === "memory") as {
    execute(id: string, params: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  }
  const input = { ...params }
  await pi.dispatch("tool_call", { toolName: "memory", toolCallId: "call-1", input }, session)
  return tool.execute("call-1", input)
}

async function composedPrompt(pi: MemoryFakeExtensionAPI, session: unknown): Promise<string> {
  const results = await pi.dispatch("system_prompt", { type: "system_prompt", systemPrompt: "BASE" }, session)
  const result = results.find((value) => value !== undefined) as { systemPrompt: string } | undefined
  return result?.systemPrompt ?? "BASE"
}

describe("createMemoryComponent", () => {
  test("#given missing custom-entry capabilities #when registered #then it warns once and registers nothing", () => {
    const pi = new FakeExtensionAPI()
    ;(pi as { appendEntry?: unknown }).appendEntry = undefined
    ;(pi as { registerEntryRenderer?: unknown }).registerEntryRenderer = undefined
    const ctx = componentContext()

    createMemoryComponent({ loadConfig: () => loadedMemoryConfig(memorySettings()) }).register(pi, ctx)

    expect(ctx.logs.filter((entry) => entry.level === "warn")).toHaveLength(1)
    expect({ handlers: pi.handlers, tools: pi.tools, commands: pi.commands }).toEqual({ handlers: [], tools: [], commands: [] })
  })

  test("#given disabled config or a disable flag #when registered #then nothing is registered", () => {
    for (const scenario of [
      { memory: memorySettings({ enabled: false }), flags: {} },
      { memory: memorySettings(), flags: { "rubato-disabled": true } },
      { memory: memorySettings(), flags: { "rubato-memory-disabled": true } },
    ]) {
      const pi = new MemoryFakeExtensionAPI()
      createMemoryComponent({ loadConfig: () => loadedMemoryConfig(scenario.memory) }).register(pi, componentContext(scenario.flags))
      expect({ handlers: pi.handlers, tools: pi.tools, commands: pi.commands }).toEqual({ handlers: [], tools: [], commands: [] })
    }
  })
})

describe("stores are named only", () => {
  test("#given a folder whose config leaves memory.agent unset #when a session writes memory #then no store is created and the tool says how to turn memory on", async () => {
    const { pi, session, memoryHome } = setup()

    await pi.dispatch("session_start", {}, session)
    const result = await executeMemory(pi, session, { command: "create", reason: "r", file_path: "decisions/x.md", description: "x" })

    expect(pi.entries.some((entry) => entry.customType === MEMORY_BINDING_CUSTOM_TYPE)).toBe(false)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain(MEMORY_UNBOUND_MESSAGE)
    expect(existsSync(join(memoryHome, "agents"))).toBe(false)
  })

  test("#given a folder in a git repository and no config #when a session starts and then writes #then the store appears only at the write, named after the root, with the root recorded", async () => {
    const { pi, session, memoryHome, cwd } = setup({ git: true })
    const storeDir = join(memoryHome, "agents", "project")

    await pi.dispatch("session_start", {}, session)
    expect(existsSync(storeDir)).toBe(false)
    const result = await executeMemory(pi, session, { command: "create", reason: "why", file_path: "decisions/a.md", description: "a" })

    expect(result.isError).not.toBe(true)
    expect(JSON.parse(readFileSync(join(storeDir, "store.json"), "utf8"))).toEqual({ roots: [realpathSync.native(cwd)] })
  })

  test("#given a named store #when the first write lands #then the store starts from an empty commit with no seed files", async () => {
    const { pi, session, memoryHome } = setup({ agent: "proj" })

    await pi.dispatch("session_start", {}, session)
    const result = await executeMemory(pi, session, {
      command: "create", reason: "why the cache key has the model", file_path: "decisions/cache-key.md", description: "Cache key",
    })

    expect(result.isError).not.toBe(true)
    const repo = new GitMemoryRepo({ dir: join(memoryHome, "agents", "proj", "repo"), agentId: "proj" })
    const head = await repo.head()
    expect(head).not.toBeNull()
    expect(await repo.lsTree(head ?? undefined)).toEqual(["decisions/cache-key.md"])
    const log = await repo.log()
    expect(log).toHaveLength(2)
    expect(log[0]?.trailers["Rubato-Session"]).toBe("session-1")
  })

  test("#given model-supplied provenance in an unnamed folder #when a memory call arrives #then the provenance is stripped", async () => {
    const { pi, session } = setup()
    await pi.dispatch("session_start", {}, session)
    const input: Record<string, unknown> = { provenance: { identityId: "other", repoPath: "/elsewhere", sessionId: "s" } }

    await pi.dispatch("tool_call", { toolName: "mcp__rubato-memory_memory", toolCallId: "c", input }, session)

    expect(input.provenance).toBeUndefined()
  })
})

describe("resident user.md and soul.md", () => {
  function writeSelf(memoryHome: string, files: Record<string, string>) {
    const dir = join(memoryHome, "self", "repo")
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  }

  test("#given user.md and soul.md #when the prompt is composed #then both ride the system prompt, fixed at session start", async () => {
    const { pi, session, memoryHome } = setup()
    writeSelf(memoryHome, { "user.md": "Prefers Korean.\n", "soul.md": "Dry humour.\n" })

    await pi.dispatch("session_start", {}, session)
    const first = await composedPrompt(pi, session)
    writeSelf(memoryHome, { "user.md": "Edited mid-session.\n" })
    const second = await composedPrompt(pi, session)

    expect(first).toContain("Prefers Korean.")
    expect(first).toContain("Dry humour.")
    expect(first.startsWith("BASE")).toBe(true)
    expect(second).toBe(first)
  })

  test("#given missing or empty files #when the prompt is composed #then memory adds nothing", async () => {
    const { pi, session, memoryHome } = setup()
    writeSelf(memoryHome, { "user.md": "  \n" })

    await pi.dispatch("session_start", {}, session)

    expect(await composedPrompt(pi, session)).toBe("BASE")
    expect(pi.entries.some((entry) => entry.customType === RESIDENT_ENTRY_TYPE)).toBe(false)
  })

  test("#given a resumed session that recorded its snapshot #when it starts again after an edit #then it keeps the recorded block", async () => {
    const { pi, memoryHome } = setup()
    writeSelf(memoryHome, { "user.md": "Changed since.\n" })
    const recorded = { type: "custom", customType: RESIDENT_ENTRY_TYPE, data: { block: "<memory>\n<user>Recorded.</user>\n</memory>" } }
    const session = sessionContext({ entries: [recorded] })

    await pi.dispatch("session_start", {}, session)
    const prompt = await composedPrompt(pi, session)

    expect(prompt).toContain("Recorded.")
    expect(prompt).not.toContain("Changed since.")
  })

  test("#given no self store #when a session starts #then it is created with an empty commit", async () => {
    const { pi, session, memoryHome } = setup()

    await pi.dispatch("session_start", {}, session)
    const dir = join(memoryHome, "self", "repo")
    for (let attempt = 0; attempt < 100 && !existsSync(join(dir, ".git")); attempt += 1) await Bun.sleep(20)
    const repo = new GitMemoryRepo({ dir, agentId: "self" })
    for (let attempt = 0; attempt < 100 && (await repo.head().catch(() => null)) === null; attempt += 1) await Bun.sleep(20)

    expect(await repo.head()).not.toBeNull()
    expect(readdirSync(dir).filter((name) => name !== ".git")).toEqual([])
  })
})

describe("automatic dream", () => {
  test("#given a session a person is at #when it starts and ends #then rubato dream --due is asked both times", async () => {
    const { pi, session, dream } = setup({ agent: "proj" })

    await pi.dispatch("session_start", {}, session)
    await pi.dispatch("session_shutdown", { reason: "quit" }, session)

    expect(dream.reasons).toEqual(["session_start", "session_end"])
  })

  test("#given a session without a UI (print-mode worker) #when it starts and ends #then no dream is launched", async () => {
    const { pi, session, dream } = setup({ agent: "proj", hasUI: false })

    await pi.dispatch("session_start", {}, session)
    await pi.dispatch("session_shutdown", { reason: "quit" }, session)

    expect(dream.reasons).toEqual([])
  })
})
