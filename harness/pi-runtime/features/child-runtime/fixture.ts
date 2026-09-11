import assert from "node:assert/strict"
import { readdir, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { Type } from "typebox"

import { InProcessRunner } from "../../../../packages/senpi-task/src/runners/in-process"
import { RpcProcessRunner } from "../../../../packages/senpi-task/src/runners/rpc-process"
import { buildRpcSpawn } from "../../../../packages/senpi-task/src/runners/rpc/spawn"
import {
  createStockChildInProcessSession,
  createStockRpcSpawnRuntime,
  loadStockChildInProcessFactories,
  resolveStockChildProviderProfile,
} from "./stock-rpc-runtime.mjs"

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
  contextWindow: 100_000,
  maxTokens: 256,
}

function assistantMessage(content: unknown[], stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  }
}

function fixtureStream(options: { signal?: AbortSignal } | undefined, delay: number, message = assistantMessage([{ type: "text", text: "fixture-local-response" }])): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  const timer = setTimeout(() => {
    if (options?.signal?.aborted) return
    stream.push({ type: "start", partial: { ...message, content: [] } })
    stream.push({ type: "done", reason: message.stopReason, message })
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

function sequencedStream(steps: ReturnType<typeof assistantMessage>[], delay = 20) {
  let call = 0
  return (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
    const message = steps[Math.min(call, steps.length - 1)]
    call += 1
    return fixtureStream(options, delay, message)
  }
}

const textStream = sequencedStream([assistantMessage([{ type: "text", text: "fixture-local-response" }])])

function cwdWriteThenText(content: string) {
  return sequencedStream([
    assistantMessage([{ type: "toolCall", id: "cwd-probe", name: "write", arguments: { path: "cwd-probe.txt", content } }], "toolUse"),
    assistantMessage([{ type: "text", text: "fixture-local-response" }]),
  ])
}

async function assertChildBashCwd(session: { executeTool: Function }, childCwd: string, parentCwd: string) {
  const result = await session.executeTool("bash", { command: "pwd > bash-cwd.txt && pwd" })
  assert.notEqual(result?.isError, true, JSON.stringify(result))
  const probe = join(childCwd, "bash-cwd.txt")
  assert.equal(existsSync(probe), true, "child bash must write bash-cwd.txt in the child cwd")
  const recorded = (await readFile(probe, "utf8")).trim().split("\n").at(-1)?.trim() ?? ""
  assert.equal(realpathSync(recorded), realpathSync(childCwd), `bash cwd ${recorded} vs ${childCwd}`)
  assert.equal(existsSync(join(parentCwd, "bash-cwd.txt")), false, "child bash must not write into the parent cwd")
  return recorded
}

async function assertLoopGuardBlocks(session: { executeTool: Function }, toolName: string, args: Record<string, unknown> = {}) {
  let blockedReason: string | undefined
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const result = await session.executeTool(toolName, args)
      const text = JSON.stringify(result)
      if (result?.isError && /Loop guard blocked|blocked repeated call/.test(text)) {
        blockedReason = text
        break
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : ""
      if (code === "blocked" || /Loop guard blocked|blocked repeated call/.test(message)) {
        blockedReason = message
        break
      }
      throw error
    }
  }
  assert.ok(blockedReason, "loop-guard must block a repeated identical child tool call")
  return blockedReason
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

let lastInProcessSession: { executeTool: Function } | undefined

async function createLocalSession(options: Record<string, unknown>) {
  const modelRuntime = options.modelRuntime as Record<string, unknown>
  modelRuntime.getAuth ??= async () => ({ auth: { apiKey: "fixture-local" } })
  modelRuntime.stream ??= textStream
  modelRuntime.streamSimple ??= modelRuntime.stream
  const extensionFactories = await loadStockChildInProcessFactories({
    root: runtimeRoot,
    agentDir: String(options.agentDir),
  })
  const session = await createStockChildInProcessSession(options, {
    createAgentSession,
    DefaultResourceLoader,
    extensionFactories,
  })
  lastInProcessSession = session
  return session
}

async function runInProcessFixture(root: string) {
  const cwd = join(root, "in-process-cwd")
  const stateDir = join(root, "in-process-state")
  const sessionDir = join(stateDir, "sessions", "in-process-task")
  const agentDir = join(root, "agent")
  await mkdir(cwd, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  const parentCwd = join(root, "parent-cwd")
  await mkdir(parentCwd, { recursive: true })
  await writeFile(join(parentCwd, "parent-only.txt"), "parent")
  const inProcessStream = cwdWriteThenText("in-process-child")
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
    stream: inProcessStream,
    streamSimple: inProcessStream,
  }
  const tool = {
    name: "fixture_tool",
    label: "fixture_tool",
    description: "fixture local tool",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "tool-ok" }] }),
  }
  const runner = new InProcessRunner({
    sharedParentTools: [tool, {
      name: "write",
      label: "write",
      description: "parent cwd write",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id: string, args: { path: string; content: string }) => {
        await writeFile(join(parentCwd, args.path), `parent-leak:${args.content}`)
        return { content: [{ type: "text", text: "parent-write" }] }
      },
    }, {
      name: "bash",
      label: "bash",
      description: "parent cwd bash",
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => {
        await writeFile(join(parentCwd, "bash-cwd.txt"), `parent-leak:${parentCwd}`)
        return { content: [{ type: "text", text: "parent-bash" }] }
      },
    }],
    createSession: createLocalSession,
  })
  let handle: Awaited<ReturnType<InProcessRunner["start"]>> | undefined
  let bashCwd = ""
  let loopGuardReason = ""
  try {
    handle = await runner.start({
      taskId: "in-process-task",
      cwd,
      sessionDir,
      agentDir,
      modelRuntime,
      model,
      toolAllowlist: ["fixture_tool", "write", "bash"],
      depth: 0,
      parentSessionId: "parent",
      rootSessionId: "root",
      prompt: "local fixture",
    })
    const outcome = await withTimeout(handle.waitForIdle(), "in-process completion", 8_000)
    assert.equal(outcome.status, "completed", JSON.stringify(outcome))
    assert.equal(handle.lastAssistantText(), "fixture-local-response")
    const files = (await readdir(sessionDir)).filter((entry) => entry.endsWith(".jsonl"))
    assert.equal(files.length, 1)
    const transcript = await readFile(join(sessionDir, files[0]), "utf8")
    assert.match(transcript, /fixture-local-response/)
    assert.match(transcript, /rubato\.context-window\.init\.v1/)
    const childProbe = join(cwd, "cwd-probe.txt")
    const parentProbe = join(parentCwd, "cwd-probe.txt")
    assert.equal(existsSync(childProbe), true, "in-process child write must land in the child cwd")
    assert.equal(await readFile(childProbe, "utf8"), "in-process-child")
    assert.equal(existsSync(parentProbe), false, "in-process child must not execute the parent cwd write tool")
    assert.ok(lastInProcessSession, "in-process child session must remain available for tool measurements")
    bashCwd = await assertChildBashCwd(lastInProcessSession, cwd, parentCwd)
    loopGuardReason = await assertLoopGuardBlocks(lastInProcessSession, "fixture_tool")
  } finally {
    handle?.dispose()
  }

  let abortStartedResolve!: () => void
  const abortStarted = new Promise<void>((resolve) => { abortStartedResolve = resolve })
  const abortStream = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
    abortStartedResolve()
    return textStream(_model, _context, options)
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
      toolAllowlist: ["fixture_tool", "write"],
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
  }
  return {
    childCwd: cwd,
    childProbe: join(cwd, "cwd-probe.txt"),
    parentCwd,
    parentProbeExists: existsSync(join(parentCwd, "cwd-probe.txt")),
    notesInit: true,
    bashCwd,
    bashParentProbeExists: existsSync(join(parentCwd, "bash-cwd.txt")),
    loopGuardReason,
    loopGuardBlocked: /Loop guard blocked|blocked repeated call/.test(loopGuardReason),
  }
}

async function runRpcFixture(root: string) {
  const cwd = join(root, "rpc-cwd")
  const stateDir = join(root, "rpc-state")
  const sessionDir = join(stateDir, "sessions", "rpc-task")
  const agentDir = join(root, "rpc-agent")
  const parentCwd = join(root, "rpc-parent-cwd")
  await mkdir(sessionDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(parentCwd, { recursive: true })
  await writeFile(join(parentCwd, "parent-only.txt"), "parent")
  const capturePath = join(root, "rpc-provider-capture.jsonl")
  const providerPath = join(root, "rpc-provider.mjs")
  const childProfile = resolveStockChildProviderProfile({ root: runtimeRoot, includeContextNotes: true, includeGuards: true })
  assert.equal(childProfile.rpcExtensions.some((entry) => entry.endsWith(`${join("context-notes", "extension.mjs")}`)), true)
  assert.equal(childProfile.rpcExtensions.some((entry) => entry.endsWith(`${join("child-runtime", "guard-extension.mjs")}`)), true)
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
      const calls = (globalThis.__rubatoRpcCalls = (globalThis.__rubatoRpcCalls ?? 0) + 1);
      const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const message = calls === 1
        ? { role: "assistant", content: [{ type: "toolCall", id: "cwd-probe", name: "write", arguments: { path: "cwd-probe.txt", content: "rpc-child" } }], api: "openai-completions", provider: "fixture-provider", model: model.id, usage, stopReason: "toolUse", timestamp: Date.now() }
        : calls === 2
        ? { role: "assistant", content: [{ type: "toolCall", id: "bash-cwd", name: "bash", arguments: { command: "pwd > bash-cwd.txt && pwd" } }], api: "openai-completions", provider: "fixture-provider", model: model.id, usage, stopReason: "toolUse", timestamp: Date.now() }
        : calls >= 3 && calls <= 9
        ? { role: "assistant", content: [{ type: "toolCall", id: "loop-guard-" + calls, name: "bash", arguments: { command: "true" } }], api: "openai-completions", provider: "fixture-provider", model: model.id, usage, stopReason: "toolUse", timestamp: Date.now() }
        : { role: "assistant", content: [{ type: "text", text: "fixture-rpc-response" }], api: "openai-completions", provider: "fixture-provider", model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [] } }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
      return stream;
    },
  });
}
`)
  const runtime = createStockRpcSpawnRuntime({
    rpcEntry,
    parentEnv: {
      ...process.env,
      HOME: join(root, "home"),
      PATH: "",
      SENPI_BIN: "/global/senpi",
      PI_CODING_AGENT_DIR: agentDir,
      RUBATO_CONTEXT_MODE: "history-notes",
    },
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
    assert.equal(descriptor.args.includes("--extension"), true)
    assert.equal(childProfile.rpcExtensions.every((entry) => descriptor.args.includes(entry)), true)
    await withTimeout(handle.waitForIdle(), "rpc fixture completion", 30_000)
    const capturedText = await readFile(capturePath, "utf8").catch((error) => `capture-read-error:${String(error)}`)
    const entries = await handle.getEntries?.().catch((error) => ({ entriesError: String(error) }))
    assert.equal(handle.lastAssistantText(), "fixture-rpc-response", JSON.stringify({ terminal: handle.terminalAssistantMessage?.(), capturedText, entries, descriptor }) ?? "missing terminal assistant message")
    const captures = capturedText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(captures.length >= 4, capturedText)
    assert.equal(captures[0].provider, "fixture-provider")
    assert.equal(captures[0].model, "fixture-model")
    const childProbe = join(cwd, "cwd-probe.txt")
    const parentProbe = join(parentCwd, "cwd-probe.txt")
    assert.equal(existsSync(childProbe), true, "RPC child write must land in the child cwd")
    assert.equal(await readFile(childProbe, "utf8"), "rpc-child")
    assert.equal(existsSync(parentProbe), false, "RPC child must not write into the parent cwd")
    const transcript = JSON.stringify(entries)
    assert.match(transcript, /rubato\.context-window\.init\.v1/)
    const bashProbe = join(cwd, "bash-cwd.txt")
    assert.equal(existsSync(bashProbe), true, "RPC child bash must write bash-cwd.txt in the child cwd")
    const bashCwd = (await readFile(bashProbe, "utf8")).trim().split("\n").at(-1)?.trim() ?? ""
    assert.equal(realpathSync(bashCwd), realpathSync(cwd), `rpc bash cwd ${bashCwd} vs ${cwd}`)
    assert.equal(existsSync(join(parentCwd, "bash-cwd.txt")), false, "RPC child bash must not write into the parent cwd")
    assert.match(transcript, /Loop guard blocked|blocked repeated call|loop-guard:notice/)
    const loopGuardReason = transcript.match(/Loop guard blocked[^"\\]*|blocked repeated call[^"\\]*|loop-guard:notice/)?.[0] ?? ""
    await withTimeout(handle.terminate({ sigkillDelayMs: 500 }), "rpc terminate", 2_000)
    const exit = await withTimeout(handle.waitForExit(), "rpc child exit", 2_000)
    assert.ok(exit, "RPC child did not report an exit outcome")
    return {
      childCwd: cwd,
      childProbe,
      parentCwd,
      parentProbeExists: existsSync(parentProbe),
      rpcExtensions: childProfile.rpcExtensions.map((entry) => basename(entry)),
      notesInit: true,
      bashCwd,
      bashParentProbeExists: existsSync(join(parentCwd, "bash-cwd.txt")),
      loopGuardReason,
      loopGuardBlocked: /Loop guard blocked|blocked repeated call|loop-guard:notice/.test(loopGuardReason),
    }
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
  const inProcess = await runInProcessFixture(root)
  const rpc = await runRpcFixture(root)
  console.log(JSON.stringify({ ok: true, runtimeRoot, rpcEntry, inProcess, rpc }))
} finally {
  await rm(root, { recursive: true, force: true })
}
