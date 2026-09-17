import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
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
  resolveStockRpcEntry,
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
  const result = await handlers.before_agent_start(
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
            resolve(JSON.parse(line))
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
    assert.match(member, /# Workstream owner/)
    const explicit = await childSystemPrompt({ RUBATO_PI_ROLE: "verifier" })
    assert.match(explicit, /# Workstream owner/)
  })
})
