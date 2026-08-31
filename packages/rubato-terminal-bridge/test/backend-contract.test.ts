import { describe, expect, test } from "bun:test"
import {
  buildAttachArgv,
  BunTerminalBackend,
  createTerminalBackend,
  decodeTerminalFrame,
  encodeTerminalFrame,
  NodePtyTerminalBackend,
  type HelperProcess,
  type TerminalBackend,
  type TerminalBackendSession,
} from "../src/index.js"

const openOptions = { zmxBinary: "/opt/rubato/bin/zmx", zmxName: "rubato-018f1e2d3c4b", cols: 80, rows: 24 }
const encoder = new TextEncoder()

interface BackendHarness {
  readonly backend: TerminalBackend
  emitOutput(value: string): void
  emitExit(): void
  writtenInput(): string
  resized(): readonly [number, number] | undefined
  wasClosed(): boolean
  command(): readonly string[]
}

function contract(name: string, create: () => BackendHarness): void {
  describe(`${name} backend contract`, () => {
    test("bridges output, input, resize, exit, output flow control, and attach-only close", async () => {
      const harness = create()
      const output: string[] = []
      let exited = false
      const session = await harness.backend.open(openOptions, {
        output(data) { output.push(new TextDecoder().decode(data)); return false },
        exit() { exited = true },
        error(error) { throw error },
      })
      harness.emitOutput("hello")
      expect(output).toEqual(["hello"])
      expect(session.writeInput(encoder.encode("whoami\r"))).toBe(true)
      session.resize(132, 43)
      expect(harness.writtenInput()).toBe("whoami\r")
      expect(harness.resized()).toEqual([132, 43])
      await session.close()
      expect(harness.wasClosed()).toBe(true)
      expect(harness.command()).toEqual(["/usr/bin/env", "-u", "ZMX_SESSION", "/opt/rubato/bin/zmx", "attach", "rubato-018f1e2d3c4b"])
      expect(exited).toBe(false)
    })

    test("reports attach-client exit", async () => {
      const harness = create()
      let exited = false
      await harness.backend.open(openOptions, { output: () => true, exit() { exited = true }, error(error) { throw error } })
      harness.emitExit()
      expect(exited).toBe(true)
    })
  })
}

class FakeHelper implements HelperProcess {
  readonly inputFrames: ReturnType<typeof decodeTerminalFrame>[] = []
  readonly args: string[] = []
  readonly #stdoutData: Array<(data: Uint8Array) => void> = []
  readonly #stdoutEnd: Array<() => void> = []
  readonly #stderrData: Array<(data: Uint8Array) => void> = []
  readonly #drain = new Set<() => void>()
  readonly stdin = {
    write: (data: Uint8Array) => { this.inputFrames.push(decodeTerminalFrame(data)); return true },
    end: () => undefined,
    once: (_event: "drain", listener: () => void) => { this.#drain.add(listener) },
    off: (_event: "drain", listener: () => void) => { this.#drain.delete(listener) },
  }
  readonly stdout = {
    on: (event: "data" | "end", listener: ((data: Uint8Array) => void) | (() => void)) => {
      if (event === "data") this.#stdoutData.push(listener as (data: Uint8Array) => void)
      else this.#stdoutEnd.push(listener as () => void)
    },
    pause: () => undefined,
    resume: () => undefined,
  }
  readonly stderr = { on: (_event: "data", listener: (data: Uint8Array) => void) => { this.#stderrData.push(listener) } }
  readonly exited = new Promise<number | null>(() => undefined)
  killed = false
  kill(): boolean { this.killed = true; return true }
  emit(frame: Uint8Array): void { for (const listener of this.#stdoutData) listener(frame) }
}

function bunHarness(): BackendHarness {
  const helper = new FakeHelper()
  let spawnCommand = ""
  let spawnArgs: readonly string[] = []
  const backend = new BunTerminalBackend({ bunBinary: "/opt/bun", helperPath: "/opt/helper.ts", spawner: {
    spawn(command, args) { spawnCommand = command; spawnArgs = args; return helper },
  } })
  return {
    backend,
    emitOutput(value) { helper.emit(encodeTerminalFrame({ type: "output", data: encoder.encode(value) })) },
    emitExit() { helper.emit(encodeTerminalFrame({ type: "exit" })) },
    writtenInput() {
      const frame = helper.inputFrames.find((item) => item.type === "input")
      return frame?.type === "input" ? new TextDecoder().decode(frame.data) : ""
    },
    resized() {
      const frame = helper.inputFrames.find((item) => item.type === "resize")
      return frame?.type === "resize" ? [frame.cols, frame.rows] : undefined
    },
    wasClosed() { return helper.inputFrames.some((item) => item.type === "exit") && !helper.killed },
    command() {
      expect(spawnCommand).toBe("/opt/bun")
      expect(spawnArgs.slice(0, 2)).toEqual(["/opt/helper.ts", "--zmx"])
      return buildAttachArgv(openOptions)
    },
  }
}

class FakePty {
  readonly dataListeners: Array<(value: string) => void> = []
  readonly exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = []
  input = ""
  size: [number, number] | undefined
  killed = false
  paused = false
  write(data: string): void { this.input += data }
  resize(cols: number, rows: number): void { this.size = [cols, rows] }
  pause(): void { this.paused = true }
  resume(): void { this.paused = false }
  kill(): void { this.killed = true }
  onData(listener: (data: string) => void): { dispose(): void } { this.dataListeners.push(listener); return { dispose() {} } }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } { this.exitListeners.push(listener); return { dispose() {} } }
}

function nodePtyHarness(): BackendHarness {
  const pty = new FakePty()
  let command: readonly string[] = []
  const backend = new NodePtyTerminalBackend({ loader: async () => ({
    spawn(file, args) { command = [file, ...args]; return pty },
  }) })
  return {
    backend,
    emitOutput(value) { for (const listener of pty.dataListeners) listener(value) },
    emitExit() { for (const listener of pty.exitListeners) listener({ exitCode: 0 }) },
    writtenInput() { return pty.input },
    resized() { return pty.size },
    wasClosed() { return pty.killed },
    command() { return command },
  }
}

contract("Bun helper", bunHarness)
contract("node-pty", nodePtyHarness)

describe("backend selection and argv safety", () => {
  test("defaults to Bun and never silently selects node-pty", () => {
    expect(createTerminalBackend()).toBeInstanceOf(BunTerminalBackend)
    expect(() => createTerminalBackend({ selection: "node-pty" })).toThrow("explicit")
    expect(createTerminalBackend({ selection: "node-pty", allowNodePtyFallback: true })).toBeInstanceOf(NodePtyTerminalBackend)
  })

  test("constructs a fixed argv and rejects metacharacter zmx names without spawning", async () => {
    expect(buildAttachArgv(openOptions)).toEqual(["/usr/bin/env", "-u", "ZMX_SESSION", "/opt/rubato/bin/zmx", "attach", "rubato-018f1e2d3c4b"])
    expect(() => buildAttachArgv({ ...openOptions, zmxName: "rubato-018f1e2d3c4b;$(touch /tmp/pwned)" })).toThrow("canonical")
    expect(() => buildAttachArgv({ ...openOptions, zmxBinary: "zmx" })).toThrow("absolute")
    let spawned = false
    const backend = new BunTerminalBackend({ spawner: { spawn() { spawned = true; throw new Error("must not spawn") } } })
    await expect(backend.open({ ...openOptions, zmxName: "rubato-018f1e2d3c4b && echo owned" }, { output: () => true, exit() {}, error() {} })).rejects.toThrow("canonical")
    expect(spawned).toBe(false)
  })
})
