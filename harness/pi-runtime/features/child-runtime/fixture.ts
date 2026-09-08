import assert from "node:assert/strict"
import { readdir, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { Type } from "typebox"

import { InProcessRunner } from "../../../../packages/senpi-task/src/runners/in-process"
import { createChildResourceLoader } from "../../../../packages/senpi-task/src/runners/in-process/child-loader"
import { RpcProcessRunner } from "../../../../packages/senpi-task/src/runners/rpc-process"
import { buildRpcSpawn } from "../../../../packages/senpi-task/src/runners/rpc/spawn"
import { createStockRpcSpawnRuntime, resolveStockChildProviderProfile } from "./stock-rpc-runtime.mjs"

const runtimeRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const rpcEntry = join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js")

const model = {
  id: "fixture-model",
  name: "Fixture Provider Model",
  api: "openai-completions",
  provider: "fixture-provider",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4_000,
  maxTokens: 256,
}

function localStream(_model: unknown, _context: unknown, options?: { signal?: AbortSignal }): AssistantMessageEventStream {
  return fixtureStream(options, 20)
}

function fixtureStream(options: { signal?: AbortSignal } | undefined, delay: number): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "fixture-local-response" }],
    api: "openai-completions",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }
  const timer = setTimeout(() => {
    if (options?.signal?.aborted) return
    stream.push({ type: "start", partial: { ...message, content: [] } })
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } })
    stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture-local-response", partial: message })
    stream.push({ type: "text_end", contentIndex: 0, content: "fixture-local-response", partial: message })
    stream.push({ type: "done", reason: "stop", message })
    stream.end(message)
  }, delay)
  options?.signal?.addEventListener("abort", () => {
    clearTimeout(timer)
    const error = { ...message, stopReason: "aborted", errorMessage: "fixture abort" }
    stream.push({ type: "error", reason: "aborted", error })
    stream.end(error)
  }, { once: true })
  return stream
}

async function withTimeout<T>(operation: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

let inProcessExtensionFactories: readonly unknown[] = []

async function createLocalSession(options: Record<string, unknown>) {
  const modelRuntime = options.modelRuntime as Record<string, unknown>
  modelRuntime.getAuth ??= async () => ({ auth: { apiKey: "fixture-local" } })
  modelRuntime.stream ??= localStream
  modelRuntime.streamSimple ??= modelRuntime.stream
  if (inProcessExtensionFactories.length > 0) {
    options.resourceLoader = createChildResourceLoader({
      cwd: String(options.cwd),
      agentDir: String(options.agentDir),
      settingsManager: options.settingsManager,
      extensionFactories: inProcessExtensionFactories,
    })
  }
  const created = await createAgentSession(options)
  const extensionErrors = (options.resourceLoader as { getExtensions?: () => { errors?: unknown[] } } | undefined)?.getExtensions?.().errors ?? []
  if (extensionErrors.length > 0) throw new Error(`child extension load failed: ${JSON.stringify(extensionErrors)}`)
  return created.session
}

async function runInProcessFixture(root: string): Promise<void> {
  const cwd = join(root, "in-process-cwd")
  const stateDir = join(root, "in-process-state")
  const sessionDir = join(stateDir, "sessions", "in-process-task")
  const agentDir = join(root, "agent")
  await mkdir(cwd, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  const contextNotesPath = pathToFileURL(join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/rubato-features/context-notes/extension.mjs")).href
  const guardPath = pathToFileURL(join(runtimeRoot, "rubato-features/child-runtime/guard-extension.mjs")).href
  const { createContextNotesExtension } = await import(contextNotesPath)
  const { createStockChildGuardExtension } = await import(guardPath)
  inProcessExtensionFactories = [createContextNotesExtension({ agentDir, enabled: true }), createStockChildGuardExtension()]
  const modelRuntime = {
    getModels: () => [model],
    getModel: () => model,
    getAvailable: async () => [model],
    getAuth: async (requestedModel: unknown) => {
      assert.equal((requestedModel as { provider?: string }).provider, "fixture-provider")
      return { auth: { apiKey: "fixture-inprocess-auth" } }
    },
    hasConfiguredAuth: () => true,
    getCompatibilityRequestConfig: () => ({}),
    stream: localStream,
    streamSimple: localStream,
  }
  const tool = {
    name: "fixture_tool",
    label: "fixture_tool",
    description: "fixture local tool",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "tool-ok" }] }),
  }
  const runner = new InProcessRunner({
    sharedParentTools: [tool],
    createSession: createLocalSession,
  })
  let handle: Awaited<ReturnType<InProcessRunner["start"]>> | undefined
  try {
    handle = await runner.start({
      taskId: "in-process-task",
      cwd,
      sessionDir,
      agentDir,
      modelRuntime,
      model,
      toolAllowlist: ["fixture_tool"],
      depth: 0,
      parentSessionId: "parent",
      rootSessionId: "root",
      prompt: "local fixture",
    })
    const outcome = await withTimeout(handle.waitForIdle(), "in-process completion", 2_000)
    assert.equal(outcome.status, "completed", JSON.stringify(outcome))
    assert.equal(handle.lastAssistantText(), "fixture-local-response")
    const files = (await readdir(sessionDir)).filter((entry) => entry.endsWith(".jsonl"))
    assert.equal(files.length, 1)
    assert.match(await readFile(join(sessionDir, files[0]), "utf8"), /fixture-local-response/)
  } finally {
    handle?.dispose()
  }

  let abortStartedResolve!: () => void
  const abortStarted = new Promise<void>((resolve) => { abortStartedResolve = resolve })
  const abortStream = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
    abortStartedResolve()
    return localStream(_model, _context, options)
  }
  const abortModelRuntime = { ...modelRuntime, stream: abortStream, streamSimple: abortStream }
  let abortHandle: Awaited<ReturnType<InProcessRunner["start"]>> | undefined
  try {
    abortHandle = await runner.start({
      taskId: "abort-task",
      cwd,
      sessionDir: join(stateDir, "sessions", "abort-task"),
      agentDir,
      modelRuntime: abortModelRuntime,
      model,
      toolAllowlist: ["fixture_tool"],
      depth: 0,
      parentSessionId: "parent",
      rootSessionId: "root",
      prompt: "abort fixture",
    })
    await withTimeout(abortStarted, "in-process stream start", 2_000)
    await withTimeout(abortHandle.abort(), "in-process abort", 2_000)
    const abortOutcome = await withTimeout(abortHandle.waitForIdle(), "in-process abort settle", 2_000)
    assert.ok(abortOutcome.status === "cancelled" || abortOutcome.status === "error", JSON.stringify(abortOutcome))
  } finally {
    abortHandle?.dispose()
    inProcessExtensionFactories = []
  }
}

async function runRpcFixture(root: string): Promise<void> {
  const cwd = join(root, "rpc-cwd")
  const stateDir = join(root, "rpc-state")
  const sessionDir = join(stateDir, "sessions", "rpc-task")
  await mkdir(sessionDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const capturePath = join(root, "rpc-provider-capture.jsonl")
  const providerPath = join(root, "rpc-provider.mjs")
  const childProfile = resolveStockChildProviderProfile({ root: runtimeRoot, includeContextNotes: true, includeGuards: true })
  const eventStreamPath = pathToFileURL(join(
    runtimeRoot,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
  )).href
  await writeFile(providerPath, `
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from ${JSON.stringify(eventStreamPath)};
const capturePath = ${JSON.stringify(capturePath)};
export default function fixtureProvider(pi) {
  pi.registerProvider("fixture-provider", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey: "fixture-rpc-auth",
    models: [{ id: "fixture-model", input: ["text"], contextWindow: 100000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      appendFileSync(capturePath, JSON.stringify({ provider: model.provider, model: model.id, auth: "fixture-rpc-auth", text: context.messages.length }) + "\\n");
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "fixture-rpc-response" }], api: "openai-completions", provider: "fixture-provider", model: model.id, usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [] } }); stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
      return stream;
    },
  });
}
`)
  const runtime = createStockRpcSpawnRuntime({
    rpcEntry,
    parentEnv: { ...process.env, HOME: join(root, "home"), PATH: "", SENPI_BIN: "/global/senpi" },
  })
  let descriptor: ReturnType<typeof buildRpcSpawn> | undefined
  let handle: Awaited<ReturnType<RpcProcessRunner["start"]>> | undefined
  const runner = new RpcProcessRunner({
    modelAdmission: async () => {},
    buildSpawn: (spec) => (descriptor = buildRpcSpawn(spec, runtime)),
  })
  try {
    handle = await withTimeout(runner.start({
      task_id: "rpc-task",
      cwd,
      state_dir: stateDir,
      prompt: "rpc fixture",
      model: "fixture-provider/fixture-model",
      extensions: [...childProfile.rpcExtensions, providerPath],
    }), "rpc runner start", 5_000)
    assert.ok(descriptor)
    assert.match(descriptor.env.PI_CODING_AGENT_SESSION_DIR ?? "", /rpc-state[\\/]sessions[\\/]rpc-task[\\/]$/)
    assert.equal(descriptor.env.SENPI_CODING_AGENT_SESSION_DIR, undefined)
    await withTimeout(handle.waitForIdle(), "rpc fixture completion", 10_000)
    const capturedText = await readFile(capturePath, "utf8").catch((error) => `capture-read-error:${String(error)}`)
    const entries = await handle.getEntries?.().catch((error) => ({ entriesError: String(error) }))
    assert.equal(handle.lastAssistantText(), "fixture-rpc-response", JSON.stringify({ terminal: handle.terminalAssistantMessage?.(), capturedText, entries, descriptor }) ?? "missing terminal assistant message")
    const captures = capturedText.trim().split("\\n").map((line) => JSON.parse(line))
    assert.deepEqual(captures, [{ provider: "fixture-provider", model: "fixture-model", auth: "fixture-rpc-auth", text: 1 }])
    await withTimeout(handle.terminate({ sigkillDelayMs: 500 }), "rpc terminate", 2_000)
    const exit = await withTimeout(handle.waitForExit(), "rpc child exit", 2_000)
    assert.ok(exit, "RPC child did not report an exit outcome")
  } finally {
    if (handle?.exitOutcome() === undefined && handle?.pid !== undefined) {
      try { await handle.terminate({ sigkillDelayMs: 200 }) } catch {}
      if (handle.exitOutcome() === undefined) {
        try { process.kill(handle.pid, "SIGKILL") } catch {}
      }
      await withTimeout(handle.waitForExit(), "rpc emergency child exit", 2_000).catch(() => {})
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "rubato-child-e2e-"))
try {
  await mkdir(join(root, "home"), { recursive: true })
  process.env.HOME = join(root, "home")
  process.env.PI_OFFLINE = "1"
  process.env.RUBATO_CONTEXT_MODE = "history-notes"
  await runInProcessFixture(root)
  await runRpcFixture(root)
  console.log(JSON.stringify({ ok: true, runtimeRoot, rpcEntry }))
} finally {
  await rm(root, { recursive: true, force: true })
}
