import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { once } from "node:events"
import { describe, test } from "node:test"
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import {
  createPiChildFeatureProfile,
  createStockChildInProcessSession,
  createPiRpcSpawnRuntime,
  loadPiChildInProcessFactories,
  resolvePiChildProviderProfile,
  resolveStockRpcEntry,
  serviceTierExtensionPath,
  PI_PACKAGE,
  PI_RPC_ENTRY,
} from "./stock-rpc-runtime.mjs"
import { createStockChildRolePromptExtension } from "./role-prompt-extension.mjs"

const RUNTIME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const ROLE_PROMPT_ENV = {
  RUBATO_ROLE_PROMPT_MODULE: pathToFileURL(join(RUNTIME_ROOT, "..", "rubato-pi", "src", "system-prompt.mjs")).href,
  RUBATO_ROLE_CONTRACT_MODULE: pathToFileURL(join(RUNTIME_ROOT, "..", "rubato-pi", "src", "role-contract.mjs")).href,
}

async function childSystemPrompt(env) {
  const handlers = {}
  await createStockChildRolePromptExtension({ env: { ...ROLE_PROMPT_ENV, ...env } })({
    on(name, fn) { handlers[name] = fn },
  })
  const result = await handlers.system_prompt(
    { systemPrompt: "You are an expert coding assistant operating inside pi, a coding agent harness." },
    { model: { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" } },
  )
  return result.systemPrompt
}
const PATCHABLE_RPC_ENTRY = join(
  RUNTIME_ROOT,
  "node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
)

describe("stock Pi child RPC runtime", () => {
  test("builds a narrow provider-only child profile", () => {
    const profile = createPiChildFeatureProfile({ rpcExtensions: ["/provider.mjs", "/provider.mjs", "/other.mjs"] })
    assert.deepEqual(profile.rpcExtensions, ["/provider.mjs", "/other.mjs"])
    assert.deepEqual(profile.inProcessFactories, [])
    assert.throws(() => createPiChildFeatureProfile({ rpcExtensions: ["relative.mjs"] }), /absolute, non-empty strings/)
  })
  test("in-process session factory fails closed without stock SDK seams", async () => {
    await assert.rejects(
      () => createStockChildInProcessSession({ cwd: RUNTIME_ROOT, agentDir: RUNTIME_ROOT, settingsManager: {} }),
      /requires createAgentSession/
    )
  })

  test("resolves the installed stock export, not Senpi's rpc entry", () => {
    const entry = resolveStockRpcEntry({ root: RUNTIME_ROOT })
    assert.equal(PI_PACKAGE, "@earendil-works/pi-coding-agent")
    assert.equal(PI_RPC_ENTRY, `${PI_PACKAGE}/rpc-entry`)
    assert.match(entry, /@earendil-works\/pi-coding-agent/)
    assert.match(entry, /rpc-entry/)
    assert.doesNotMatch(entry, /@code-yeongyu\/senpi/)
    assert.equal(existsSync(entry), true)
  })

  test("never consults SENPI_BIN or PATH when selecting a child", () => {
    const runtime = createPiRpcSpawnRuntime({
      rpcEntry: PATCHABLE_RPC_ENTRY,
      parentEnv: { SENPI_BIN: "/global/senpi", PATH: "/global/bin" },
      execPath: "/usr/bin/node",
      platform: "linux",
    })
    assert.equal(runtime.resolveSenpiExecutable(runtime), null)
    assert.match(runtime.resolveRpcEntry(), /@earendil-works\/pi-coding-agent/)
    assert.equal(runtime.sessionDirEnvName, "PI_CODING_AGENT_SESSION_DIR")
  })

  test("boots a real stock RPC child and answers the get_state readiness handshake", async (t) => {
    const runtime = createPiRpcSpawnRuntime({ rpcEntry: PATCHABLE_RPC_ENTRY, parentEnv: {} })
    const root = mkdtempSync(join(tmpdir(), "rubato-stock-child-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const sessionDir = join(root, "sessions", "child")
    const homeDir = join(root, "home")
    mkdirSync(homeDir)
    const child = spawn(runtime.execPath, [runtime.resolveRpcEntry(), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"], {
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: "",
        PI_OFFLINE: "1",
        SENPI_BIN: "/definitely/not-used",
        PI_CODING_AGENT_SESSION_DIR: `${sessionDir}/`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    try {
      const response = await new Promise((resolve, reject) => {
        let buffer = ""
        const timer = setTimeout(() => reject(new Error("stock RPC readiness timeout")), 15_000)
        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (chunk) => {
          buffer += chunk
          const line = buffer.split("\n").find((entry) => entry.trim().length > 0)
          if (line === undefined) return
          clearTimeout(timer)
          try {
            resolve(JSON.parse(line));
          } catch (error) {
            reject(error)
          }
        })
        child.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.stdin.write('{"type":"get_state","id":"stock-ready"}\n')
      })
      assert.deepEqual(
        { id: response.id, type: response.type, command: response.command, success: response.success },
        { id: "stock-ready", type: "response", command: "get_state", success: true },
      )
      assert.match(response.data.sessionFile, /sessions\/child\//)
    } finally {
      if (!child.killed) child.kill()
      if (child.exitCode === null) await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 2_000))])
    }
  })

  test("creates an in-process child with an injected model/tool and isolated transcript", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "rubato-stock-inproc-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const cwd = join(root, "cwd")
    const sessionDir = join(root, "sessions")
    const agentDir = join(root, "agent")
    mkdirSync(cwd)
    mkdirSync(sessionDir)
    mkdirSync(agentDir)
    const model = {
      id: "local/mock",
      name: "Local Mock",
      api: "openai-completions",
      provider: "local",
      baseUrl: "http://127.0.0.1:9",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    }
    const modelRuntime = await ModelRuntime.create({
      agentDir,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    })
    const customTool = {
      name: "child_probe",
      label: "child_probe",
      description: "local child probe",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }
    const sessionManager = SessionManager.create(cwd, sessionDir)
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      customTools: [customTool],
      tools: ["child_probe"],
    })
    try {
      assert.equal(session.model?.id, "local/mock")
      assert.deepEqual(session.getActiveToolNames(), ["child_probe"])
      assert.ok(session.sessionFile.startsWith(`${sessionDir}/`))
      // A synthetic assistant entry flushes the same JSONL path used by a real
      // turn without making a provider request.
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "openai-completions",
        provider: "local",
        model: "mock",
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      })
      assert.equal(existsSync(session.sessionFile), true)
      assert.match(readFileSync(session.sessionFile, "utf8"), /"text":"ok"/)
    } finally {
      session.dispose()
    }
  })

  test("an unmarked child gets the agent role prompt instead of stock pi's", async () => {
    const prompt = await childSystemPrompt({})
    assert.match(prompt, /# Assigned agent/)
    assert.match(prompt, /# Working agreement/)
    // Anthropic reads the system prompt to decide whether a plan-billed request
    // is Claude Code; pi's own harness prompt is rejected as a third-party app.
    assert.doesNotMatch(prompt, /operating inside pi, a coding agent harness/)
  })

  test("a child keeps the role its environment already names", async () => {
    const member = await childSystemPrompt({ SENPI_TASK_MEMBER: "1" })
    assert.match(member, /^# Teammate$/m)
    assert.match(member, /^Role: owner$/m)
    assert.match(member, /technical integration belongs here when assigned/)
    const explicit = await childSystemPrompt({ RUBATO_PI_ROLE: "verifier" })
    assert.match(explicit, /^# Teammate$/m)
    assert.match(explicit, /^Role: verifier$/m)
    assert.match(explicit, /Do not implement the production change you will judge/)
  })
})

function stageChildRoot() {
  const root = mkdtempSync(join(tmpdir(), "rubato-child-tier-"))
  const touch = (path) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "")
  }
  touch(join(root, "rubato-features", "child-runtime", "provider-extension.mjs"))
  touch(join(
    root,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/rubato-features/provider-execution/extension.mjs",
  ))
  const tierExtension = serviceTierExtensionPath(root)
  mkdirSync(dirname(tierExtension), { recursive: true })
  writeFileSync(tierExtension, `
export function createServiceTierFeature(options = {}) {
  const extension = () => {}
  extension.initialTier = options.initialTier
  extension.readServiceTierEnv = options.readServiceTierEnv
  return { extension }
}
`)
  return root
}

describe("child service-tier closure", () => {
  test("includes the service-tier extension only when a tier is requested", async () => {
    const root = stageChildRoot()
    const plain = resolvePiChildProviderProfile({ root })
    const fast = resolvePiChildProviderProfile({ root, serviceTier: "priority" })
    assert.equal(plain.rpcExtensions.some((entry) => entry.endsWith(join("service-tier", "extension.mjs"))), false)
    assert.equal(fast.rpcExtensions.some((entry) => entry === serviceTierExtensionPath(root)), true)

    const plainFactories = await loadPiChildInProcessFactories({
      root,
      includeContextNotes: false,
      includeGuards: false,
      includeRolePrompt: false,
    })
    const fastFactories = await loadPiChildInProcessFactories({
      root,
      includeContextNotes: false,
      includeGuards: false,
      includeRolePrompt: false,
      serviceTier: "priority",
    })
    assert.equal(plainFactories.some((entry) => entry.name === "service-tier"), false)
    assert.equal(fastFactories.length, 1)
    assert.equal(fastFactories[0].name, "service-tier")
    assert.equal(fastFactories[0].factory.initialTier, "priority")
    assert.equal(fastFactories[0].factory.readServiceTierEnv, false)
  })

  test("createPiRpcSpawnRuntime exposes the staged service-tier path for a later per-child append", () => {
    const runtime = createPiRpcSpawnRuntime({ rpcEntry: PATCHABLE_RPC_ENTRY, parentEnv: {} })
    assert.equal(
      runtime.serviceTierExtension.endsWith(join("rubato-features", "service-tier", "extension.mjs")),
      true,
    )
  })
})
