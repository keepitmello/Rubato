#!/usr/bin/env bun
import { buildAttachArgv } from "./backend.js"
import {
  encodeTerminalFrame,
  MAX_TERMINAL_PAYLOAD_BYTES,
  TerminalFrameDecoder,
  type TerminalFrame,
} from "./frame.js"

const MAX_HELPER_OUTPUT_BUFFER_BYTES = 1024 * 1024

export interface BunTerminalLike {
  write(data: Uint8Array): number
  resize(cols: number, rows: number): void
  close(): void
}

export interface BunAttachProcess {
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

export interface BunTerminalRuntime {
  createTerminal(options: {
    readonly cols: number
    readonly rows: number
    readonly name: string
    readonly data: (terminal: BunTerminalLike, data: Uint8Array) => void
  }): BunTerminalLike
  spawn(argv: readonly string[], options: { readonly terminal: BunTerminalLike }): BunAttachProcess
  writeStdout(data: Uint8Array): boolean
  onStdoutDrain(listener: () => void): void
}

export interface BunHelperInput {
  readonly zmxBinary: string
  readonly zmxName: string
  readonly cols: number
  readonly rows: number
  readonly envBinary?: string
}

export class BunTerminalHelper {
  readonly #runtime: BunTerminalRuntime
  readonly #input: BunHelperInput
  readonly #decoder = new TerminalFrameDecoder()
  readonly #queuedOutput: Uint8Array[] = []
  #queuedOutputBytes = 0
  #terminal: BunTerminalLike | null = null
  #process: BunAttachProcess | null = null
  #closed = false
  #blocked = false
  readonly completed: Promise<void>
  readonly #complete: () => void

  constructor(input: BunHelperInput, runtime: BunTerminalRuntime) {
    this.#input = input
    this.#runtime = runtime
    let complete!: () => void
    this.completed = new Promise<void>((resolve) => { complete = resolve })
    this.#complete = complete
  }

  start(): void {
    if (this.#terminal) throw new Error("terminal helper already started")
    const argv = buildAttachArgv(this.#input)
    const terminal = this.#runtime.createTerminal({
      cols: this.#input.cols,
      rows: this.#input.rows,
      name: "xterm-256color",
      data: (_terminal, data) => this.#emitOutput(data),
    })
    this.#terminal = terminal
    this.#process = this.#runtime.spawn(argv, { terminal })
    void this.#process.exited.then(() => this.#finish(), (cause: unknown) => this.#fail(cause))
  }

  accept(chunk: Uint8Array): void {
    if (this.#closed) return
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handle(frame)
    } catch (cause) {
      this.#fail(cause)
    }
  }

  finishInput(): void {
    if (this.#closed) return
    try {
      this.#decoder.finish()
      this.close()
    } catch (cause) {
      this.#fail(cause)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#process?.kill("SIGTERM")
    this.#terminal?.close()
    this.#complete()
  }

  #handle(frame: TerminalFrame): void {
    switch (frame.type) {
      case "input":
        this.#terminal?.write(frame.data)
        return
      case "resize":
        this.#terminal?.resize(frame.cols, frame.rows)
        return
      case "exit":
        this.close()
        return
      default:
        throw new Error(`Node bridge sent forbidden ${frame.type} frame`)
    }
  }

  #emitOutput(data: Uint8Array): void {
    for (let offset = 0; offset < data.byteLength; offset += MAX_TERMINAL_PAYLOAD_BYTES) {
      const frame = encodeTerminalFrame({ type: "output", data: data.subarray(offset, offset + MAX_TERMINAL_PAYLOAD_BYTES) })
      this.#send(frame)
      if (this.#closed) return
    }
  }

  #send(frame: Uint8Array): void {
    if (this.#closed) return
    if (!this.#blocked && this.#queuedOutput.length === 0) {
      this.#blocked = !this.#runtime.writeStdout(frame)
      if (this.#blocked) this.#runtime.onStdoutDrain(() => this.#flush())
      return
    }
    if (this.#queuedOutputBytes + frame.byteLength > MAX_HELPER_OUTPUT_BUFFER_BYTES) {
      this.#fail(new Error("terminal helper output backpressure limit exceeded"))
      return
    }
    this.#queuedOutput.push(frame)
    this.#queuedOutputBytes += frame.byteLength
  }

  #flush(): void {
    if (this.#closed) return
    this.#blocked = false
    while (this.#queuedOutput.length > 0) {
      const frame = this.#queuedOutput.shift()!
      this.#queuedOutputBytes -= frame.byteLength
      if (!this.#runtime.writeStdout(frame)) {
        this.#blocked = true
        this.#runtime.onStdoutDrain(() => this.#flush())
        return
      }
    }
  }

  #finish(): void {
    if (this.#closed) return
    this.#send(encodeTerminalFrame({ type: "exit" }))
    this.#closed = true
    this.#terminal?.close()
    this.#complete()
  }

  #fail(cause: unknown): void {
    if (this.#closed) return
    const message = cause instanceof Error ? cause.message : String(cause)
    const bounded = new TextDecoder().decode(new TextEncoder().encode(message).subarray(0, 16 * 1024))
    this.#send(encodeTerminalFrame({ type: "error", message: bounded }))
    this.#send(encodeTerminalFrame({ type: "exit" }))
    this.close()
  }
}

export function parseBunHelperArguments(argv: readonly string[]): BunHelperInput {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag || !value || !["--zmx", "--name", "--cols", "--rows"].includes(flag) || values.has(flag)) {
      throw new Error("usage: bun-helper --zmx <path> --name <zmxName> --cols <number> --rows <number>")
    }
    values.set(flag, value)
  }
  if (values.size !== 4) throw new Error("usage: bun-helper --zmx <path> --name <zmxName> --cols <number> --rows <number>")
  return {
    zmxBinary: values.get("--zmx")!,
    zmxName: values.get("--name")!,
    cols: Number(values.get("--cols")),
    rows: Number(values.get("--rows")),
  }
}

function realRuntime(): BunTerminalRuntime {
  return {
    createTerminal(options) {
      return new Bun.Terminal({
        cols: options.cols,
        rows: options.rows,
        name: options.name,
        data: (terminal, data) => options.data(terminal, data),
      })
    },
    spawn(argv, options) {
      return Bun.spawn([...argv], { terminal: options.terminal as Bun.Terminal })
    },
    writeStdout(data) { return process.stdout.write(data) },
    onStdoutDrain(listener) { process.stdout.once("drain", listener) },
  }
}

async function main(): Promise<void> {
  let helper: BunTerminalHelper | null = null
  try {
    helper = new BunTerminalHelper(parseBunHelperArguments(Bun.argv.slice(2)), realRuntime())
    helper.start()
    const stop = (): void => helper?.close()
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    const readInput = async (): Promise<void> => {
      for await (const chunk of process.stdin) helper!.accept(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
      helper!.finishInput()
    }
    const reading = readInput()
    await Promise.race([reading, helper.completed])
    if (process.stdin.readable) process.stdin.destroy()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    process.stdout.write(encodeTerminalFrame({ type: "error", message }))
    process.stdout.write(encodeTerminalFrame({ type: "exit" }))
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
