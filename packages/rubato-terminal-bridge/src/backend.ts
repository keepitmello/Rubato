import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeTerminalFrame, assertTerminalSize, TerminalFrameDecoder, type TerminalFrame } from "./frame.js"
import { assertCanonicalZmxName } from "./tickets.js"

export interface TerminalOpenOptions {
  readonly zmxBinary: string
  readonly zmxName: string
  readonly cols: number
  readonly rows: number
}

export interface TerminalBackendHandlers {
  /** Return false to pause backend output until resumeOutput() is called. */
  output(data: Uint8Array): boolean
  exit(): void
  error(error: Error): void
}

export interface TerminalBackendSession {
  writeInput(data: Uint8Array): boolean
  onInputDrain(listener: () => void): () => void
  resize(cols: number, rows: number): void
  pauseOutput(): void
  resumeOutput(): void
  close(): Promise<void>
}

export interface TerminalBackend {
  open(options: TerminalOpenOptions, handlers: TerminalBackendHandlers): Promise<TerminalBackendSession>
}

export interface HelperProcess {
  readonly stdin: {
    write(data: Uint8Array): boolean
    end(): void
    once(event: "drain", listener: () => void): void
    off(event: "drain", listener: () => void): void
  }
  readonly stdout: {
    on(event: "data", listener: (data: Uint8Array) => void): void
    on(event: "end", listener: () => void): void
    pause(): void
    resume(): void
  }
  readonly stderr: {
    on(event: "data", listener: (data: Uint8Array) => void): void
  }
  readonly exited: Promise<number | null>
  kill(signal?: NodeJS.Signals): boolean
}

export interface HelperProcessSpawner {
  spawn(command: string, args: readonly string[]): HelperProcess
}

export class NodeHelperProcessSpawner implements HelperProcessSpawner {
  spawn(command: string, args: readonly string[]): HelperProcess {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true }) as ChildProcessWithoutNullStreams
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => resolve(code))
      }),
      kill: (signal) => child.kill(signal),
    }
  }
}

export class BunTerminalBackend implements TerminalBackend {
  readonly #bunBinary: string
  readonly #helperPath: string
  readonly #spawner: HelperProcessSpawner

  constructor(options: { readonly bunBinary?: string; readonly helperPath?: string; readonly spawner?: HelperProcessSpawner } = {}) {
    this.#bunBinary = options.bunBinary ?? process.env["RUBATO_BUN_BIN"] ?? "bun"
    this.#helperPath = options.helperPath ?? fileURLToPath(new URL("./bun-helper.ts", import.meta.url))
    this.#spawner = options.spawner ?? new NodeHelperProcessSpawner()
  }

  async open(options: TerminalOpenOptions, handlers: TerminalBackendHandlers): Promise<TerminalBackendSession> {
    validateOpenOptions(options)
    const child = this.#spawner.spawn(this.#bunBinary, [
      this.#helperPath,
      "--zmx", options.zmxBinary,
      "--name", options.zmxName,
      "--cols", String(options.cols),
      "--rows", String(options.rows),
    ])
    const decoder = new TerminalFrameDecoder()
    let closed = false
    let exitedFrame = false
    let stderr = ""
    const textDecoder = new TextDecoder()

    const fail = (error: Error): void => {
      if (closed) return
      closed = true
      handlers.error(error)
      child.stdin.end()
      child.kill("SIGTERM")
    }
    child.stderr.on("data", (data) => {
      if (stderr.length < 16_384) stderr += textDecoder.decode(data, { stream: true }).slice(0, 16_384 - stderr.length)
    })
    child.stdout.on("data", (data) => {
      if (closed) return
      try {
        for (const frame of decoder.push(data)) {
          if (frame.type === "output") {
            if (!handlers.output(frame.data)) child.stdout.pause()
          } else if (frame.type === "exit") {
            exitedFrame = true
            handlers.exit()
          } else if (frame.type === "error") {
            handlers.error(new Error(frame.message))
          } else {
            throw new Error(`Bun terminal helper sent forbidden ${frame.type} frame`)
          }
        }
      } catch (cause) {
        fail(asError(cause))
      }
    })
    child.stdout.on("end", () => {
      if (closed) return
      try {
        decoder.finish()
      } catch (cause) {
        fail(asError(cause))
      }
    })
    void child.exited.then((code) => {
      if (closed) return
      closed = true
      if (!exitedFrame && code !== 0) handlers.error(new Error(stderr.trim() || `Bun terminal helper exited with code ${String(code)}`))
      if (!exitedFrame) handlers.exit()
    }, (cause: unknown) => fail(asError(cause)))

    const drainListeners = new Set<() => void>()
    const onDrain = (): void => { for (const listener of drainListeners) listener() }
    child.stdin.once("drain", onDrain)
    return {
      writeInput(data) {
        if (closed) return false
        return child.stdin.write(encodeTerminalFrame({ type: "input", data }))
      },
      onInputDrain(listener) {
        drainListeners.add(listener)
        child.stdin.once("drain", onDrain)
        return () => {
          drainListeners.delete(listener)
          child.stdin.off("drain", onDrain)
        }
      },
      resize(cols, rows) {
        if (!closed) child.stdin.write(encodeTerminalFrame({ type: "resize", cols, rows }))
      },
      pauseOutput() { child.stdout.pause() },
      resumeOutput() { if (!closed) child.stdout.resume() },
      async close() {
        if (closed) return
        closed = true
        child.stdin.write(encodeTerminalFrame({ type: "exit" }))
        child.stdin.end()
      },
    }
  }
}

interface NodePtyProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

interface NodePtyModule {
  spawn(file: string, args: readonly string[], options: { name: string; cols: number; rows: number; env: Record<string, string> }): NodePtyProcess
}

export type NodePtyLoader = () => Promise<NodePtyModule>

export class NodePtyTerminalBackend implements TerminalBackend {
  readonly #loader: NodePtyLoader
  readonly #envBinary: string

  constructor(options: { readonly loader?: NodePtyLoader; readonly envBinary?: string } = {}) {
    this.#loader = options.loader ?? loadNodePty
    this.#envBinary = options.envBinary ?? "/usr/bin/env"
  }

  async open(options: TerminalOpenOptions, handlers: TerminalBackendHandlers): Promise<TerminalBackendSession> {
    validateOpenOptions(options)
    const nodePty = await this.#loader()
    const process = nodePty.spawn(this.#envBinary, ["-u", "ZMX_SESSION", options.zmxBinary, "attach", options.zmxName], {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      env: stringEnvironment(globalThis.process.env),
    })
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    let closed = false
    const dataSubscription = process.onData((data) => {
      if (!closed && !handlers.output(encoder.encode(data))) process.pause()
    })
    const exitSubscription = process.onExit(() => {
      if (closed) return
      closed = true
      handlers.exit()
    })
    return {
      writeInput(data) {
        if (closed) return false
        process.write(decoder.decode(data))
        return true
      },
      onInputDrain() { return () => undefined },
      resize(cols, rows) {
        assertTerminalSize(cols, rows)
        if (!closed) process.resize(cols, rows)
      },
      pauseOutput() { process.pause() },
      resumeOutput() { if (!closed) process.resume() },
      async close() {
        if (closed) return
        closed = true
        dataSubscription.dispose()
        exitSubscription.dispose()
        process.kill("SIGTERM")
      },
    }
  }
}

export type TerminalBackendSelection = "bun" | "node-pty"

export function createTerminalBackend(options: {
  readonly selection?: TerminalBackendSelection
  readonly allowNodePtyFallback?: boolean
  readonly bun?: ConstructorParameters<typeof BunTerminalBackend>[0]
  readonly nodePty?: ConstructorParameters<typeof NodePtyTerminalBackend>[0]
} = {}): TerminalBackend {
  const selection = options.selection ?? "bun"
  if (selection === "bun") return new BunTerminalBackend(options.bun)
  if (!options.allowNodePtyFallback) throw new Error("node-pty fallback requires the explicit allowNodePtyFallback feature flag")
  return new NodePtyTerminalBackend(options.nodePty)
}

export function buildAttachArgv(input: { readonly envBinary?: string; readonly zmxBinary: string; readonly zmxName: string }): readonly string[] {
  if (!isAbsolute(input.zmxBinary) || input.zmxBinary.includes("\0")) throw new TypeError("pinned zmx binary path must be absolute and NUL-free")
  assertCanonicalZmxName(input.zmxName)
  const envBinary = input.envBinary ?? "/usr/bin/env"
  if (!isAbsolute(envBinary) || envBinary.includes("\0")) throw new TypeError("env binary path must be absolute and NUL-free")
  return [envBinary, "-u", "ZMX_SESSION", input.zmxBinary, "attach", input.zmxName]
}

async function loadNodePty(): Promise<NodePtyModule> {
  const packageName: string = "node-pty"
  try {
    return await import(packageName) as NodePtyModule
  } catch (cause) {
    throw new Error("node-pty@1.1.0 fallback was selected but is not installed", { cause })
  }
}

function validateOpenOptions(options: TerminalOpenOptions): void {
  buildAttachArgv(options)
  assertTerminalSize(options.cols, options.rows)
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) if (value !== undefined && name !== "ZMX_SESSION") result[name] = value
  return result
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function isBackendOutputFrame(frame: TerminalFrame): boolean {
  return frame.type === "output" || frame.type === "exit" || frame.type === "error"
}
