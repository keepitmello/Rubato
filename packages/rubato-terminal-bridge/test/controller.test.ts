import { describe, expect, test } from "bun:test"
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  MAX_TERMINAL_PAYLOAD_BYTES,
  TerminalBridgeController,
  type TerminalBackend,
  type TerminalBackendHandlers,
  type TerminalBackendSession,
  type TerminalBridgeScheduler,
  type TerminalBridgeSink,
} from "../src/index.js"

const options = {
  ticket: "a".repeat(43),
  origin: "https://phone.example.test",
  ownerLogin: "owner@example.test",
  zmxBinary: "/opt/rubato/bin/zmx",
  zmxName: "rubato-018f1e2d3c4b",
  cols: 80,
  rows: 24,
}

class FakeSession implements TerminalBackendSession {
  readonly inputs: Uint8Array[] = []
  readonly sizes: Array<[number, number]> = []
  readonly drains = new Set<() => void>()
  writable = true
  closed = false
  paused = false
  writeInput(data: Uint8Array): boolean { this.inputs.push(data.slice()); return this.writable }
  onInputDrain(listener: () => void): () => void { this.drains.add(listener); return () => this.drains.delete(listener) }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]) }
  pauseOutput(): void { this.paused = true }
  resumeOutput(): void { this.paused = false }
  async close(): Promise<void> { this.closed = true }
  drain(): void { for (const listener of this.drains) listener() }
}

class FakeBackend implements TerminalBackend {
  readonly session = new FakeSession()
  handlers: TerminalBackendHandlers | undefined
  opens = 0
  async open(_options: typeof options, handlers: TerminalBackendHandlers): Promise<TerminalBackendSession> {
    this.opens++
    this.handlers = handlers
    return this.session
  }
}

class FakeScheduler implements TerminalBridgeScheduler {
  callback: (() => void) | undefined
  delay: number | undefined
  setTimeout(callback: () => void, delay: number): unknown { this.callback = callback; this.delay = delay; return callback }
  clearTimeout(handle: unknown): void { if (this.callback === handle) this.callback = undefined }
  fire(): void { const callback = this.callback; this.callback = undefined; callback?.() }
}

class RecordingSink implements TerminalBridgeSink {
  readonly frames: Uint8Array[] = []
  closed = false
  send(frame: Uint8Array): void { this.frames.push(frame.slice()) }
  close(): void { this.closed = true }
}

async function opened(input: { sink?: TerminalBridgeSink; idleTimeoutMs?: number } = {}) {
  const backend = new FakeBackend()
  const sink = input.sink ?? new RecordingSink()
  const scheduler = new FakeScheduler()
  const controller = new TerminalBridgeController({ backend, sink, scheduler, ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }) })
  await controller.openAuthorized(options, { consume: () => true })
  return { backend, sink, scheduler, controller }
}

describe("Node terminal bridge controller", () => {
  test("validates the launch ticket before opening a backend", async () => {
    const backend = new FakeBackend()
    const controller = new TerminalBridgeController({ backend, sink: new RecordingSink() })
    await expect(controller.openAuthorized(options, { consume: () => false })).rejects.toThrow("ticket")
    expect(backend.opens).toBe(0)
  })

  test("routes bounded client input and resize frames", async () => {
    const { backend, controller } = await opened()
    controller.receive(encodeTerminalFrame({ type: "input", data: new TextEncoder().encode("ls\r") }))
    controller.receive(encodeTerminalFrame({ type: "resize", cols: 120, rows: 40 }))
    expect(new TextDecoder().decode(backend.session.inputs[0])).toBe("ls\r")
    expect(backend.session.sizes).toEqual([[120, 40]])
  })

  test("pauses backend output until asynchronous sink backpressure drains", async () => {
    let release: (() => void) | undefined
    const sink: TerminalBridgeSink = {
      send: () => new Promise<void>((resolve) => { release = resolve }),
      close() {},
    }
    const { backend } = await opened({ sink })
    expect(backend.handlers!.output(new TextEncoder().encode("output"))).toBe(false)
    expect(backend.session.paused).toBe(true)
    release!()
    await Promise.resolve()
    await Promise.resolve()
    expect(backend.session.paused).toBe(false)
  })

  test("bounds queued input when the helper pipe applies backpressure", async () => {
    const { backend, controller } = await opened()
    backend.session.writable = false
    const frame = encodeTerminalFrame({ type: "input", data: new Uint8Array(MAX_TERMINAL_PAYLOAD_BYTES) })
    controller.receive(frame)
    controller.receive(frame)
    controller.receive(frame)
    controller.receive(frame)
    controller.receive(frame)
    expect(() => controller.receive(frame)).toThrow("backpressure limit")
    expect(controller.closed).toBe(true)
  })

  test("rejects forbidden client output and closes only the attach backend", async () => {
    const { backend, sink, controller } = await opened()
    expect(() => controller.receive(encodeTerminalFrame({ type: "output", data: new Uint8Array([1]) }))).toThrow("forbidden")
    await Promise.resolve()
    expect(backend.session.closed).toBe(true)
    expect((sink as RecordingSink).frames.map((frame) => decodeTerminalFrame(frame).type)).toEqual(["error", "exit"])
  })

  test("shuts down after exactly the configured idle interval and emits error then exit", async () => {
    const { backend, sink, scheduler, controller } = await opened({ idleTimeoutMs: 1_000 })
    expect(scheduler.delay).toBe(1_000)
    scheduler.fire()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.closed).toBe(true)
    expect(backend.session.closed).toBe(true)
    expect((sink as RecordingSink).frames.map((frame) => decodeTerminalFrame(frame).type)).toEqual(["error", "exit"])
  })
})
