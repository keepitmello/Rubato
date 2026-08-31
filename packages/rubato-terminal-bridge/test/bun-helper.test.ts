import { describe, expect, test } from "bun:test"
import {
  BunTerminalHelper,
  parseBunHelperArguments,
  type BunAttachProcess,
  type BunTerminalLike,
  type BunTerminalRuntime,
} from "../src/bun-helper.js"
import { decodeTerminalFrame, encodeTerminalFrame } from "../src/index.js"

class FakeTerminal implements BunTerminalLike {
  readonly input: Uint8Array[] = []
  sizes: Array<[number, number]> = []
  closed = false
  write(data: Uint8Array): number { this.input.push(data.slice()); return data.byteLength }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]) }
  close(): void { this.closed = true }
}

class FakeProcess implements BunAttachProcess {
  readonly exited = new Promise<number>(() => undefined)
  killed = false
  kill(): void { this.killed = true }
}

class FakeRuntime implements BunTerminalRuntime {
  readonly terminal = new FakeTerminal()
  readonly process = new FakeProcess()
  readonly output: Uint8Array[] = []
  argv: readonly string[] = []
  data: ((terminal: BunTerminalLike, data: Uint8Array) => void) | undefined
  createTerminal(options: { cols: number; rows: number; name: string; data: (terminal: BunTerminalLike, data: Uint8Array) => void }): BunTerminalLike {
    this.data = options.data
    return this.terminal
  }
  spawn(argv: readonly string[]): BunAttachProcess { this.argv = argv; return this.process }
  writeStdout(data: Uint8Array): boolean { this.output.push(data.slice()); return true }
  onStdoutDrain(): void {}
}

const input = { zmxBinary: "/opt/rubato/bin/zmx with spaces", zmxName: "rubato-018f1e2d3c4b", cols: 80, rows: 24 }

describe("Bun PTY helper", () => {
  test("spawns fixed env/zmx attach argv without shell interpolation", () => {
    const runtime = new FakeRuntime()
    const helper = new BunTerminalHelper(input, runtime)
    helper.start()
    expect(runtime.argv).toEqual(["/usr/bin/env", "-u", "ZMX_SESSION", "/opt/rubato/bin/zmx with spaces", "attach", "rubato-018f1e2d3c4b"])
    expect(runtime.argv).not.toContain("sh")
  })

  test("bridges input, resize, output, and closes only the attach process", () => {
    const runtime = new FakeRuntime()
    const helper = new BunTerminalHelper(input, runtime)
    helper.start()
    helper.accept(encodeTerminalFrame({ type: "input", data: new TextEncoder().encode("pwd\r") }))
    helper.accept(encodeTerminalFrame({ type: "resize", cols: 100, rows: 30 }))
    runtime.data!(runtime.terminal, new TextEncoder().encode("/tmp\r\n"))
    expect(new TextDecoder().decode(runtime.terminal.input[0])).toBe("pwd\r")
    expect(runtime.terminal.sizes).toEqual([[100, 30]])
    expect(decodeTerminalFrame(runtime.output[0]!)).toEqual({ type: "output", data: new TextEncoder().encode("/tmp\r\n") })
    helper.accept(encodeTerminalFrame({ type: "exit" }))
    expect(runtime.process.killed).toBe(true)
    expect(runtime.terminal.closed).toBe(true)
  })

  test("rejects forbidden, truncated, and metacharacter input before spawning", () => {
    const runtime = new FakeRuntime()
    expect(() => new BunTerminalHelper({ ...input, zmxName: "rubato-018f1e2d3c4b;rm -rf /" }, runtime).start()).toThrow("canonical")
    expect(runtime.argv).toEqual([])

    const running = new FakeRuntime()
    const helper = new BunTerminalHelper(input, running)
    helper.start()
    helper.accept(encodeTerminalFrame({ type: "output", data: new Uint8Array([1]) }))
    expect(decodeTerminalFrame(running.output[0]!).type).toBe("error")
    expect(running.process.killed).toBe(true)

    const truncated = new FakeRuntime()
    const second = new BunTerminalHelper(input, truncated)
    second.start()
    second.accept(new Uint8Array([2, 0, 0]))
    second.finishInput()
    expect(decodeTerminalFrame(truncated.output[0]!).type).toBe("error")
  })

  test("parses only the exact helper CLI", () => {
    expect(parseBunHelperArguments(["--zmx", "/zmx", "--name", "rubato-018f1e2d3c4b", "--cols", "80", "--rows", "24"])).toEqual({
      zmxBinary: "/zmx", zmxName: "rubato-018f1e2d3c4b", cols: 80, rows: 24,
    })
    expect(() => parseBunHelperArguments(["--zmx", "/zmx", "--zmx", "/other"])).toThrow("usage")
    expect(() => parseBunHelperArguments(["--shell", "bash"])).toThrow("usage")
  })
})
