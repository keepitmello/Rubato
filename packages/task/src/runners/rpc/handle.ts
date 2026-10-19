import type { ChildProcess } from "node:child_process"
import type { RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent"
import { log } from "@rubato/utils"

import type { RunnerOutcome } from "../in-process/child-handle"
import type {
  ChildAwaitedWake,
  ChildEventListener,
  ChildExitOutcome,
  ChildTurnFacts,
  RpcChildHandle,
  RpcTerminalAssistantMessage,
  TerminateOptions,
} from "../types"
import { type RpcStreamingBehavior, isBusyChildRejection } from "./delivery-semantics"
import { RpcCommandError } from "./errors"
import { classifyChildExit } from "./exit-mapping"
import { isHarmlessRpcShutdownError, type RpcProtocolClient } from "./protocol-client"
import { terminateRpcChild } from "./terminate"
import { agentEndOutcome, exitTurnOutcome, extractAssistantText, promptFailureOutcome } from "./turn-outcome"

/**
 * The terminal extension's answer to "what will still wake this session"
 * (harness/pi-runtime/features/terminal pending-work.ts terminalAwaitedWakes), asked through the
 * engine's extension-rpc command the same way the app asks a lead.
 */
export const CHILD_AWAITED_WAKES_REQUEST = "rubato.terminal.awaited-wakes"

export type CreateRpcChildHandleOptions = {
  readonly client: RpcProtocolClient
  readonly child: ChildProcess
  readonly taskId: string
  readonly heartbeatIntervalMs: number
  readonly now: () => number
}

export type TrackedRpcChildHandle = RpcChildHandle & {
  startInitialPrompt(text: string): Promise<void>
}

/**
 * Assemble the steerable RpcChildHandle over a protocol client: steer/followUp/
 * abort mapping, event fan-out, idle + exit awaiting, final-text tracking, and
 * a get_state liveness heartbeat (records lastSeen only). terminate() delegates
 * to the single-writer terminate module.
 */
export function createRpcChildHandle(options: CreateRpcChildHandleOptions): TrackedRpcChildHandle {
  const { client, child, taskId, heartbeatIntervalMs, now } = options
  const idleWaiters: Array<() => void> = []
  const outcomeWaiters: Array<(settled: RunnerOutcome) => void> = []
  const exitWaiters: Array<(outcome: ChildExitOutcome) => void> = []
  let reachedIdle = false
  let sessionId: string | undefined
  let finalText: string | undefined
  let turnBaseline: string | undefined
  let turnOutcome: RunnerOutcome | undefined
  let terminalAssistantMessage: RpcTerminalAssistantMessage | undefined
  let abortedByUser = false
  let lastSeenAt: number | undefined
  let outcome: ChildExitOutcome | undefined

  const settleTurn = (settled: RunnerOutcome): void => {
    if (turnOutcome !== undefined) return
    turnOutcome = settled
    reachedIdle = true
    flush(idleWaiters)
    for (const waiter of outcomeWaiters.splice(0)) waiter(settled)
  }

  client.onEvent((event) => {
    if (event.type === "message_end") {
      const terminal = extractTerminalAssistantMessage(event.message)
      if (terminal !== undefined) {
        terminalAssistantMessage = terminal
        finalText = terminal.text ?? finalText
      }
    }
    if (event.type === "agent_end" && event.willRetry === false) {
      settleTurn(abortedByUser ? { status: "cancelled" } : agentEndOutcome(event, turnBaseline, finalText))
    }
  })

  const heartbeat = setInterval(() => {
    if (client.exited || child.stdin?.writableEnded || child.stdin?.destroyed) return
    client
      .send({ type: "get_state" })
      .then((response) => {
        lastSeenAt = now()
        sessionId = readSessionId(response) ?? sessionId
      })
      .catch((error: unknown) => {
        if (client.exited || isHarmlessRpcShutdownError(error)) return
        log("senpi-task heartbeat get_state failed", { taskId, error: String(error) })
      })
  }, heartbeatIntervalMs)
  heartbeat.unref?.()

  const settleExit = (built: ChildExitOutcome): void => {
    if (outcome) {
      return
    }
    outcome = built
    clearInterval(heartbeat)
    flush(idleWaiters)
    if (turnOutcome === undefined) settleTurn(exitTurnOutcome(built, finalText))
    for (const waiter of exitWaiters.splice(0)) {
      waiter(built)
    }
  }

  child.once("error", (error) => settleExit(classifyChildExit({ code: null, signal: null, error, pid: child.pid, stderr: client.stderrTail })))
  child.once("close", (code, signal) => settleExit(classifyChildExit({ code, signal, pid: child.pid, stderr: client.stderrTail })))

  const runCommand = async (command: Parameters<RpcProtocolClient["send"]>[0], label: string): Promise<void> => {
    const response = await client.send(command)
    assertOk(response, label)
  }

  const beginTurn = (): void => {
    if (outcome !== undefined) return
    if (reachedIdle || turnOutcome !== undefined) {
      reachedIdle = false
      turnOutcome = undefined
    }
    terminalAssistantMessage = undefined
    abortedByUser = false
    turnBaseline = finalText
  }

  // Deliver with explicit queueing semantics, retrying as followUp when the child answers
  // "busy". Without this a mid-run delivery is rejected outright and aborts the child.
  const deliverPrompt = async (text: string, streamingBehavior: RpcStreamingBehavior): Promise<void> => {
    try {
      await runCommand({ type: "prompt", message: text, streamingBehavior }, "prompt")
    } catch (error) {
      if (streamingBehavior === "followUp" || !isBusyChildRejection(error)) throw error
      await runCommand({ type: "prompt", message: text, streamingBehavior: "followUp" }, "prompt")
    }
  }

  const runPrompt = async (text: string, streamingBehavior: RpcStreamingBehavior = "steer"): Promise<void> => {
    beginTurn()
    try {
      await deliverPrompt(text, streamingBehavior)
    } catch (error) {
      settleTurn(promptFailureOutcome(error))
      throw error
    }
  }

  return {
    task_id: taskId,
    get sessionId() {
      return sessionId
    },
    get pid() {
      return child.pid ?? undefined
    },
    // AgentSend is documented to ALWAYS steer into the addressed child, so a steer that the
    // host rejects as busy degrades to followUp queueing rather than failing the delivery.
    steer: async (text) => {
      beginTurn()
      try {
        await runCommand({ type: "steer", message: text }, "steer")
      } catch (error) {
        if (!isBusyChildRejection(error)) throw error
        await deliverPrompt(text, "followUp")
      }
    },
    followUp: (text) => runPrompt(text, "followUp"),
    abort: () => {
      abortedByUser = true
      return runCommand({ type: "abort" }, "abort")
    },
    subscribe: (listener: ChildEventListener) => client.onEvent(listener),
    waitForIdle: () =>
      reachedIdle || outcome ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve)),
    waitForOutcome: () =>
      turnOutcome !== undefined
        ? Promise.resolve(turnOutcome)
        : outcome === undefined
          ? new Promise<RunnerOutcome>((resolve) => outcomeWaiters.push(resolve))
          : Promise.resolve(exitTurnOutcome(outcome, finalText)),
    lastAssistantText: () => finalText,
    terminalAssistantMessage: () => terminalAssistantMessage,
    wasAbortedByUser: () => abortedByUser,
    lastSeen: () => lastSeenAt,
    exitOutcome: () => outcome,
    waitForExit: () => (outcome ? Promise.resolve(outcome) : new Promise<ChildExitOutcome>((resolve) => exitWaiters.push(resolve))),
    dispose: () => {
      clearInterval(heartbeat)
      client.detach()
      return Promise.resolve()
    },
    terminate: (terminateOptions?: TerminateOptions) => terminateRpcChild(child, terminateOptions),
    startInitialPrompt: (text) => runPrompt(text),
    readTurnFacts: () => readTurnFacts(client),
  }
}

async function readTurnFacts(client: RpcProtocolClient): Promise<ChildTurnFacts> {
  if (client.exited) return {}
  const ask = (command: Parameters<RpcProtocolClient["send"]>[0]) => client.send(command).catch(() => undefined)
  const [state, text, wakes] = await Promise.all([
    ask({ type: "get_state" }),
    ask({ type: "get_last_assistant_text" }),
    // extension_request is the engine's own RPC command (pi-runtime extension-rpc patch).
    ask({ type: "extension_request", name: CHILD_AWAITED_WAKES_REQUEST } as unknown as Parameters<RpcProtocolClient["send"]>[0]),
  ])
  const streaming = state?.success === true && state.command === "get_state" ? state.data.isStreaming : undefined
  const lastText = text?.success === true && text.command === "get_last_assistant_text" ? text.data.text : undefined
  const awaiting = wakes?.success === true ? awaitedWakesOf((wakes as { data?: unknown }).data) : undefined
  return {
    ...(typeof streaming === "boolean" ? { streaming } : {}),
    ...(typeof lastText === "string" && lastText.trim().length > 0 ? { lastAssistantText: lastText } : {}),
    ...(awaiting === undefined ? {} : { awaiting }),
  }
}

function awaitedWakesOf(data: unknown): readonly ChildAwaitedWake[] | undefined {
  const items = typeof data === "object" && data !== null ? (data as { items?: unknown }).items : undefined
  if (!Array.isArray(items)) return undefined
  return items.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const { id, description } = item as { id?: unknown; description?: unknown }
    if (typeof id !== "string" || id.length === 0) return []
    return [{ id, description: typeof description === "string" && description.length > 0 ? description : id }]
  })
}

function flush(waiters: Array<() => void>): void {
  for (const waiter of waiters.splice(0)) {
    waiter()
  }
}

function assertOk(response: RpcResponse, label: string): void {
  if (!response.success) {
    throw new RpcCommandError(label, response.error)
  }
}

function readSessionId(response: RpcResponse): string | undefined {
  if (response.command !== "get_state" || !response.success) {
    return undefined
  }
  const state: RpcSessionState = response.data
  return state.sessionId
}

function extractTerminalAssistantMessage(message: unknown): RpcTerminalAssistantMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const record = message as Record<string, unknown>
  if (record.role !== "assistant") return undefined
  const text = extractAssistantText(record)
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined
  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : undefined
  return {
    ...(text === undefined ? {} : { text }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }
}
