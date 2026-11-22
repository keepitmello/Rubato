import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { promisify } from "node:util"

import type { ManagedChildEvent, ManagedChildHandle, ManagedChildListener, RunnerOutcome } from "../../manager/child-handle"
import type { ManagedRunner, ManagedStartSpec } from "../../manager/types"
import { RunnerError } from "../in-process"
import {
  agyModelSlug,
  findLocalAgySync,
  isAgyAgentModel,
  minimalAgyEnv,
  resolveAgyUserHome,
} from "./agy-models"

const execFileAsync = promisify(execFile)

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "t3-code",
  title: "T3 Code",
  version: "0.1.11",
})
const DEFAULT_AGENT_NAME = "rubato-lead"
const RPC_TIMEOUT_MS = 30_000

export type AgyRunnerOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly maxConcurrent?: number
  readonly clientInfo?: { readonly name: string; readonly title?: string; readonly version: string }
  readonly defaultAgent?: string
  readonly findBinary?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined
}

type JsonRpcRecord = Record<string, unknown>

type PendingRequest = {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

function isRecord(value: unknown): value is JsonRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasListedAgent(listing: string, agent: string): boolean {
  return listing.split(/\r?\n/).some((line) => line.trim() === agent)
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content
  if (isRecord(content) && typeof content.text === "string") return content.text
  if (Array.isArray(content)) {
    return content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .join("")
  }
  return ""
}

function findConfigOption(
  configOptions: unknown,
  predicate: (option: JsonRpcRecord) => boolean,
): JsonRpcRecord | undefined {
  if (!Array.isArray(configOptions)) return undefined
  return configOptions.find((entry): entry is JsonRpcRecord => isRecord(entry) && predicate(entry))
}

function selectAutoPermissionOption(params: JsonRpcRecord): string | undefined {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : undefined
  const toolCallId = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : ""
  // Interactive user-input prompts cannot be answered by a non-interactive Agent child.
  if (toolCallId.startsWith("interaction_")) return undefined

  const options = Array.isArray(params.options) ? params.options : []
  const byKind = (kind: string) =>
    options.find(
      (entry): entry is JsonRpcRecord =>
        isRecord(entry) && entry.kind === kind && typeof entry.optionId === "string" && entry.optionId.trim().length > 0,
    )
  const preferred = byKind("allow_once") ?? byKind("allow_always")
  return typeof preferred?.optionId === "string" ? preferred.optionId : undefined
}

function composeInitialPrompt(spec: ManagedStartSpec): string {
  const instructions = spec.instructions?.trim()
  if (!instructions) return spec.prompt
  return `${instructions}\n\n${spec.prompt}`
}

async function resolveAgentArg(
  binary: string,
  preferredAgent: string | undefined,
  cwd: string,
  env: Record<string, string>,
): Promise<readonly string[]> {
  if (!preferredAgent) return []
  try {
    const { stdout } = await execFileAsync(binary, ["agents"], {
      cwd,
      env,
      timeout: 8_000,
      encoding: "utf8",
    })
    return hasListedAgent(stdout, preferredAgent) ? ["--agent", preferredAgent] : []
  } catch {
    return []
  }
}

class AgyAcpChildHandle implements ManagedChildHandle {
  readonly task_id: string
  sessionId: string | undefined
  readonly pid: number | undefined

  readonly #child: ChildProcessWithoutNullStreams
  readonly #listeners = new Set<ManagedChildListener>()
  readonly #pending = new Map<number, PendingRequest>()
  readonly #onRelease: () => void
  #nextId = 1
  #buffer = ""
  #stderr = ""
  #turnText = ""
  #lastText: string | undefined
  #runActive = false
  #aborted = false
  #disposed = false
  #released = false
  #currentOutcome: Promise<RunnerOutcome> | undefined

  constructor(
    taskId: string,
    child: ChildProcessWithoutNullStreams,
    onRelease: () => void,
  ) {
    this.task_id = taskId
    this.pid = child.pid
    this.#child = child
    this.#onRelease = onRelease

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      let nl = this.#buffer.indexOf("\n")
      while (nl !== -1) {
        const line = this.#buffer.slice(0, nl).replace(/\r$/, "").trim()
        this.#buffer = this.#buffer.slice(nl + 1)
        if (line.length > 0) this.#handleLine(line)
        nl = this.#buffer.indexOf("\n")
      }
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      if (this.#stderr.length < 4096) this.#stderr += text
    })
    child.once("exit", (code, signal) => {
      this.#release()
      const detail = this.#stderr.trim()
      const message = detail
        ? `agy acp exited (${signal ?? code ?? "unknown"}): ${detail}`
        : `agy acp exited (${signal ?? code ?? "unknown"})`
      for (const [id, pending] of this.#pending) {
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        pending.reject(new Error(message))
        this.#pending.delete(id)
      }
    })
  }

  #release(): void {
    if (this.#released) return
    this.#released = true
    this.#onRelease()
  }

  #emit(event: ManagedChildEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // listener errors must not disrupt ACP transport
      }
    }
  }

  #write(message: Record<string, unknown>): void {
    if (this.#disposed || this.#child.stdin.destroyed) {
      throw new Error("agy acp transport is closed")
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#pending.delete(id)
              reject(new Error(`agy acp ${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.#disposed || this.#child.stdin.destroyed) return
    this.#write({ jsonrpc: "2.0", method, params })
  }

  #handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(parsed)) return

    // Response to one of our outgoing requests.
    if (typeof parsed.id === "number" && !("method" in parsed)) {
      const pending = this.#pending.get(parsed.id)
      if (pending === undefined) return
      this.#pending.delete(parsed.id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if (isRecord(parsed.error)) {
        const message = typeof parsed.error.message === "string" ? parsed.error.message : "ACP request failed"
        pending.reject(new Error(message))
      } else {
        pending.resolve(parsed.result)
      }
      return
    }

    const method = typeof parsed.method === "string" ? parsed.method : ""
    const params = isRecord(parsed.params) ? parsed.params : {}

    // Incoming request from agy (permission prompt).
    if ("id" in parsed && parsed.id !== undefined) {
      if (method === "session/request_permission") {
        const optionId = selectAutoPermissionOption(params)
        const result = optionId !== undefined
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } }
        try {
          this.#write({ jsonrpc: "2.0", id: parsed.id, result })
        } catch {
          // ignore if process is closing
        }
        return
      }
      try {
        this.#write({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32601, message: `Unsupported client method: ${method}` },
        })
      } catch {
        // ignore if process is closing
      }
      return
    }

    if (method === "session/update") {
      this.#handleSessionUpdate(params)
    }
  }

  #handleSessionUpdate(params: JsonRpcRecord): void {
    const update = isRecord(params.update) ? params.update : params
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : ""
    if (kind === "agent_message_chunk") {
      const delta = extractTextContent(update.content)
      if (delta.length > 0) {
        this.#turnText += delta
        this.#lastText = this.#turnText
        this.#emit({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: this.#turnText }] },
        })
      }
      return
    }
    if (kind === "tool_call") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined
      const toolName =
        typeof update.title === "string" && update.title.trim().length > 0
          ? update.title.trim()
          : typeof update.kind === "string"
            ? update.kind
            : "tool"
      this.#emit({
        type: "tool_execution_start",
        ...(toolCallId === undefined ? {} : { toolCallId }),
        toolName,
        args: update.rawInput,
      })
      return
    }
    if (kind === "tool_call_update") {
      const status = typeof update.status === "string" ? update.status : ""
      if (status === "completed" || status === "failed" || status === "cancelled") {
        const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined
        this.#emit({
          type: "tool_execution_end",
          ...(toolCallId === undefined ? {} : { toolCallId }),
          result: update.rawOutput ?? update.content,
          isError: status === "failed",
        })
      }
    }
  }

  startTurn(promptText: string): Promise<RunnerOutcome> {
    if (this.sessionId === undefined) {
      return Promise.resolve({
        status: "error",
        failure: { kind: "child-prompt-failed", message: "agy acp session is not initialized" },
      })
    }
    this.#turnText = ""
    this.#aborted = false
    this.#runActive = true

    const run = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: promptText }],
    })
      .then((result): RunnerOutcome => {
        this.#runActive = false
        if (this.#aborted) return { status: "cancelled" }
        const stopReason = isRecord(result) && typeof result.stopReason === "string" ? result.stopReason : undefined
        if (stopReason === "cancelled") return { status: "cancelled" }
        const finalText = this.#turnText.trim() || extractTextContent(isRecord(result) ? result.output : undefined).trim()
        if (finalText.length > 0) this.#lastText = finalText
        this.#emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: stopReason ?? "end_turn" },
        })
        return { status: "completed", finalResponse: finalText }
      })
      .catch((error: unknown): RunnerOutcome => {
        this.#runActive = false
        if (this.#aborted) return { status: "cancelled" }
        const message = error instanceof Error ? error.message : String(error)
        return {
          status: "error",
          failure: { kind: "child-turn-failed", message, cause: error },
        }
      })

    this.#currentOutcome = run
    return run
  }

  isRunActive(): boolean {
    return this.#runActive
  }

  async steer(text: string): Promise<void> {
    this.startTurn(text)
  }

  async followUp(text: string): Promise<void> {
    if (this.#currentOutcome !== undefined && this.#runActive) {
      await this.#currentOutcome.catch(() => undefined)
    }
    this.startTurn(text)
  }

  async abort(): Promise<void> {
    this.#aborted = true
    this.#runActive = false
    if (this.sessionId !== undefined) {
      this.notify("session/cancel", { sessionId: this.sessionId })
    }
    await this.dispose()
  }

  subscribe(listener: ManagedChildListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  waitForOutcome(): Promise<RunnerOutcome> {
    return this.#currentOutcome ?? Promise.resolve({ status: "completed", finalResponse: this.#lastText ?? "" })
  }

  lastAssistantText(): string | undefined {
    return this.#lastText
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      this.#release()
      return
    }
    this.#disposed = true
    this.#runActive = false
    try {
      this.#child.stdin.end()
    } catch {
      // ignore
    }
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      try {
        this.#child.kill("SIGTERM")
      } catch {
        // ignore
      }
    }
    this.#release()
  }
}

export function createAgyManagedRunner(options: AgyRunnerOptions = {}): ManagedRunner {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)
  const clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO
  const findBinary = options.findBinary ?? findLocalAgySync
  let activeCount = 0

  return {
    async start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
      if (spec.memberEnv !== undefined) {
        throw new RunnerError({
          kind: "session-create-failed",
          message: "agy models are for single Agent calls only, not team members.",
        })
      }
      if (activeCount >= maxConcurrent) {
        throw new RunnerError({
          kind: "session-create-failed",
          message: `Only ${maxConcurrent} agy agent may run at a time. Wait for the active agy agent to finish.`,
        })
      }
      const binary = findBinary(env, platform)
      if (binary === undefined) {
        throw new RunnerError({
          kind: "model_unavailable",
          message: "Official `agy` CLI was not found on PATH or ~/.local/bin.",
        })
      }

      const home = resolveAgyUserHome(env, platform)
      const cleanEnv = minimalAgyEnv(env, home)
      const preferredAgent = options.defaultAgent ?? env.RUBATO_AGY_AGENT?.trim() ?? DEFAULT_AGENT_NAME
      const agentArgs = await resolveAgentArg(binary, preferredAgent, spec.cwd, cleanEnv)

      activeCount += 1
      let released = false
      const releaseSlot = () => {
        if (released) return
        released = true
        activeCount = Math.max(0, activeCount - 1)
      }

      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(binary, ["acp", "--sandbox", ...agentArgs], {
          cwd: spec.cwd,
          env: cleanEnv,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        })
      } catch (error) {
        releaseSlot()
        throw new RunnerError({
          kind: "session-create-failed",
          message: `Failed to start agy acp: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        })
      }

      const handle = new AgyAcpChildHandle(spec.taskId, child, releaseSlot)
      try {
        await handle.request(
          "initialize",
          {
            protocolVersion: 1,
            clientInfo,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          },
          RPC_TIMEOUT_MS,
        )

        const sessionResult = await handle.request(
          "session/new",
          { cwd: spec.cwd, mcpServers: [] },
          RPC_TIMEOUT_MS,
        )
        if (!isRecord(sessionResult) || typeof sessionResult.sessionId !== "string" || !sessionResult.sessionId) {
          throw new Error("agy acp session/new returned no sessionId")
        }
        handle.sessionId = sessionResult.sessionId

        const configOptions = sessionResult.configOptions
        if (spec.model !== undefined) {
          const slug = agyModelSlug(spec.model)
          const modelOption = findConfigOption(configOptions, (opt) => opt.id === "model")
          if (modelOption !== undefined) {
            await handle.request(
              "session/set_config_option",
              { sessionId: handle.sessionId, configId: "model", value: slug },
              RPC_TIMEOUT_MS,
            )
          }
        }
        if (spec.variant !== undefined && spec.variant.trim().length > 0) {
          const thoughtOption = findConfigOption(configOptions, (opt) => opt.category === "thought_level")
          const configId = typeof thoughtOption?.id === "string" ? thoughtOption.id : undefined
          if (configId !== undefined) {
            await handle.request(
              "session/set_config_option",
              { sessionId: handle.sessionId, configId, value: spec.variant.trim() },
              RPC_TIMEOUT_MS,
            )
          }
        }

        handle.startTurn(composeInitialPrompt(spec))
        return handle
      } catch (error) {
        await handle.dispose()
        throw new RunnerError({
          kind: "session-create-failed",
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        })
      }
    },

    async resume(): Promise<ManagedChildHandle> {
      throw new RunnerError({
        kind: "session_unavailable",
        message: "agy agents do not support session respawn; start a new Agent call instead.",
      })
    },
  }
}

/** Route `agy/*` Agent calls to the official `agy acp` runner while keeping all other models on `base`. */
export function wrapRunnerWithAgy(base: ManagedRunner, agyRunner: ManagedRunner): ManagedRunner {
  return {
    start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
      if (isAgyAgentModel(spec.model)) return agyRunner.start(spec)
      return base.start(spec)
    },
    ...(base.resume === undefined
      ? {}
      : {
          resume(spec: ManagedStartSpec, sessionPath: string): Promise<ManagedChildHandle> {
            if (isAgyAgentModel(spec.model)) {
              return Promise.reject(
                new RunnerError({
                  kind: "session_unavailable",
                  message: "agy agents do not support session resume.",
                }),
              )
            }
            return base.resume!(spec, sessionPath)
          },
        }),
  }
}
