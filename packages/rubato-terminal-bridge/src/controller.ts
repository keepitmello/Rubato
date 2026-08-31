import type { TerminalBackend, TerminalBackendSession, TerminalOpenOptions } from "./backend.js"
import {
  encodeTerminalFrame,
  MAX_TERMINAL_PAYLOAD_BYTES,
  TerminalFrameDecoder,
  type TerminalFrame,
} from "./frame.js"
import type { TerminalLaunchIdentity, TerminalTicketValidationHook } from "./tickets.js"

export const TERMINAL_IDLE_TIMEOUT_MS = 20 * 60 * 1_000
export const MAX_BUFFERED_TERMINAL_BYTES = 1024 * 1024

export interface TerminalBridgeSink {
  send(frame: Uint8Array): void | Promise<void>
  close(): void | Promise<void>
}

export interface TerminalBridgeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface AuthorizedTerminalOpenOptions extends TerminalOpenOptions, TerminalLaunchIdentity {
  readonly ticket: string
}

export class TerminalBridgeController {
  readonly #backend: TerminalBackend
  readonly #sink: TerminalBridgeSink
  readonly #scheduler: TerminalBridgeScheduler
  readonly #idleTimeoutMs: number
  readonly #decoder = new TerminalFrameDecoder()
  readonly #outputQueue: Uint8Array[] = []
  readonly #inputQueue: Uint8Array[] = []
  #outputQueueBytes = 0
  #inputQueueBytes = 0
  #sendingOutput = false
  #outputFlush: Promise<void> | null = null
  #inputBlocked = false
  #session: TerminalBackendSession | null = null
  #idleHandle: unknown = null
  #closed = false
  #opening = false
  #removeInputDrain: (() => void) | null = null

  constructor(input: {
    readonly backend: TerminalBackend
    readonly sink: TerminalBridgeSink
    readonly scheduler?: TerminalBridgeScheduler
    readonly idleTimeoutMs?: number
  }) {
    this.#backend = input.backend
    this.#sink = input.sink
    this.#scheduler = input.scheduler ?? systemScheduler
    this.#idleTimeoutMs = input.idleTimeoutMs ?? TERMINAL_IDLE_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#idleTimeoutMs) || this.#idleTimeoutMs <= 0 || this.#idleTimeoutMs > TERMINAL_IDLE_TIMEOUT_MS) {
      throw new RangeError(`terminal idle timeout must be between 1 and ${TERMINAL_IDLE_TIMEOUT_MS} milliseconds`)
    }
  }

  async openAuthorized(options: AuthorizedTerminalOpenOptions, tickets: TerminalTicketValidationHook): Promise<void> {
    if (this.#opening || this.#session || this.#closed) throw new Error("terminal bridge cannot be opened in its current state")
    this.#opening = true
    let authorized: boolean
    try {
      authorized = await tickets.consume(options.ticket, {
        origin: options.origin,
        ownerLogin: options.ownerLogin,
        zmxName: options.zmxName,
      })
    } catch (cause) {
      this.#opening = false
      throw cause
    }
    if (!authorized) {
      this.#opening = false
      throw new Error("invalid or expired terminal launch ticket")
    }
    try {
      const session = await this.#backend.open(options, {
        output: (data) => this.#acceptBackendOutput(data),
        exit: () => { void this.close() },
        error: (error) => { void this.close(error) },
      })
      if (this.#closed) {
        await session.close()
        return
      }
      this.#session = session
      this.#removeInputDrain = session.onInputDrain(() => this.#flushInput())
      this.#opening = false
      this.#touch()
      if (!this.#sendingOutput) session.resumeOutput()
    } catch (cause) {
      this.#opening = false
      throw cause
    }
  }

  receive(chunk: Uint8Array): void {
    if (this.#closed || !this.#session) throw new Error("terminal bridge is not open")
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handleClientFrame(frame)
    } catch (cause) {
      void this.close(asError(cause))
      throw cause
    }
  }

  finishInput(): void {
    if (this.#closed) return
    try {
      this.#decoder.finish()
    } catch (cause) {
      void this.close(asError(cause))
      throw cause
    }
  }

  async close(error?: Error): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#idleHandle !== null) this.#scheduler.clearTimeout(this.#idleHandle)
    this.#removeInputDrain?.()
    const session = this.#session
    this.#session = null
    if (error) this.#enqueueOutput(encodeTerminalFrame({ type: "error", message: boundedMessage(error.message) }), true)
    this.#enqueueOutput(encodeTerminalFrame({ type: "exit" }), true)
    await session?.close()
    await this.#outputFlush
    await this.#sink.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  #handleClientFrame(frame: TerminalFrame): void {
    const session = this.#session!
    this.#touch()
    switch (frame.type) {
      case "input":
        if (this.#inputBlocked || this.#inputQueue.length > 0) {
          this.#queueInput(frame.data)
        } else if (!session.writeInput(frame.data)) {
          this.#inputBlocked = true
        }
        return
      case "resize":
        session.resize(frame.cols, frame.rows)
        return
      case "exit":
        void this.close()
        return
      default:
        throw new Error(`terminal client sent forbidden ${frame.type} frame`)
    }
  }

  #queueInput(data: Uint8Array): void {
    if (this.#inputQueueBytes + data.byteLength > MAX_BUFFERED_TERMINAL_BYTES) {
      throw new Error("terminal input backpressure limit exceeded")
    }
    const copy = data.slice()
    this.#inputQueue.push(copy)
    this.#inputQueueBytes += copy.byteLength
  }

  #flushInput(): void {
    const session = this.#session
    if (!session || this.#closed) return
    this.#inputBlocked = false
    while (this.#inputQueue.length > 0) {
      const data = this.#inputQueue.shift()!
      this.#inputQueueBytes -= data.byteLength
      if (!session.writeInput(data)) {
        this.#inputBlocked = true
        return
      }
    }
  }

  #acceptBackendOutput(data: Uint8Array): boolean {
    if (this.#closed) return false
    this.#touch()
    for (let offset = 0; offset < data.byteLength; offset += MAX_TERMINAL_PAYLOAD_BYTES) {
      this.#enqueueOutput(encodeTerminalFrame({ type: "output", data: data.subarray(offset, offset + MAX_TERMINAL_PAYLOAD_BYTES) }))
    }
    return !this.#sendingOutput && this.#outputQueue.length === 0
  }

  #enqueueOutput(frame: Uint8Array, closing = false): void {
    if (!closing && this.#outputQueueBytes + frame.byteLength > MAX_BUFFERED_TERMINAL_BYTES) {
      void this.close(new Error("terminal output backpressure limit exceeded"))
      return
    }
    this.#outputQueue.push(frame)
    this.#outputQueueBytes += frame.byteLength
    if (!this.#outputFlush) {
      this.#outputFlush = this.#flushOutput().finally(() => { this.#outputFlush = null })
    }
  }

  async #flushOutput(): Promise<void> {
    this.#sendingOutput = true
    this.#session?.pauseOutput()
    try {
      while (this.#outputQueue.length > 0) {
        const frame = this.#outputQueue.shift()!
        this.#outputQueueBytes -= frame.byteLength
        await this.#sink.send(frame)
      }
    } catch {
      if (!this.#closed) void this.close()
    } finally {
      this.#sendingOutput = false
      if (!this.#closed) this.#session?.resumeOutput()
    }
  }

  #touch(): void {
    if (this.#closed) return
    if (this.#idleHandle !== null) this.#scheduler.clearTimeout(this.#idleHandle)
    this.#idleHandle = this.#scheduler.setTimeout(() => {
      void this.close(new Error("terminal closed after 20 minutes of inactivity"))
    }, this.#idleTimeoutMs)
  }
}

const systemScheduler: TerminalBridgeScheduler = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    handle.unref()
    return handle
  },
  clearTimeout(handle) { clearTimeout(handle as NodeJS.Timeout) },
}

function boundedMessage(message: string): string {
  const bytes = new TextEncoder().encode(message)
  return new TextDecoder().decode(bytes.subarray(0, 16 * 1024))
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
