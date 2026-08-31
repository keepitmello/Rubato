import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { join } from "node:path"
import { WebSocket } from "ws"
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TerminalLaunchTicketStore,
  type TerminalBackend,
  type TerminalBackendHandlers,
  type TerminalBackendSession,
} from "@rubato/terminal-bridge"
import { EventJournal } from "../src/journal.js"
import { PairingService } from "../src/pairing.js"
import { TicketStore } from "../src/tickets.js"
import { HubWebSocketServer } from "../src/websocket.js"
import { HOST_ID, temporaryDirectory } from "./helpers.js"

const ORIGIN = "https://phone.example.ts.net"
const OWNER = "owner@example.com"
const ZMX_NAME = "rubato-018f1e2d3c4b"
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

class FakeAttachSession implements TerminalBackendSession {
  readonly inputs: Uint8Array[] = []
  readonly sizes: Array<[number, number]> = []
  readonly input = Promise.withResolvers<void>()
  readonly resized = Promise.withResolvers<void>()
  readonly didClose = Promise.withResolvers<void>()
  closed = false
  writeInput(data: Uint8Array): boolean { this.inputs.push(data.slice()); this.input.resolve(); return true }
  onInputDrain(): () => void { return () => undefined }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); this.resized.resolve() }
  pauseOutput(): void {}
  resumeOutput(): void {}
  async close(): Promise<void> { this.closed = true; this.didClose.resolve() }
}

class FakeAttachBackend implements TerminalBackend {
  session = new FakeAttachSession()
  handlers?: TerminalBackendHandlers
  options?: { zmxBinary: string; zmxName: string; cols: number; rows: number }
  #nextOpen: ((value: { session: FakeAttachSession; handlers: TerminalBackendHandlers }) => void) | undefined
  nextOpen(): Promise<{ session: FakeAttachSession; handlers: TerminalBackendHandlers }> {
    return new Promise((resolve) => { this.#nextOpen = resolve })
  }
  async open(options: { zmxBinary: string; zmxName: string; cols: number; rows: number }, handlers: TerminalBackendHandlers): Promise<TerminalBackendSession> {
    this.session = new FakeAttachSession()
    this.options = options
    this.handlers = handlers
    this.#nextOpen?.({ session: this.session, handlers })
    this.#nextOpen = undefined
    return this.session
  }
}

describe("terminal WebSocket integration", () => {
  test("enforces bound tickets and bridges binary I/O, resize, and attach-only close to the exact zmx session", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const pairing = new PairingService(join(temporary.path, "origins.json"))
    await pairing.load()
    const nonce = pairing.issueNonce()
    const claim = pairing.claim(nonce.nonce, ORIGIN, OWNER)
    await pairing.approve(claim.claimId, OWNER, true)
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
    await journal.load()
    let now = Date.parse("2026-08-31T00:00:00.000Z")
    const terminalTickets = new TerminalLaunchTicketStore({ now: () => now })
    const backend = new FakeAttachBackend()
    const server = createServer((_request, response) => response.writeHead(404).end())
    const sockets = new HubWebSocketServer({
      server,
      ownerLogin: OWNER,
      pairing,
      tickets: new TicketStore(),
      terminalTickets,
      journal,
      zmxBinary: "/opt/rubato/bin/zmx",
      terminalBackend: backend,
      identity: { verify: async ({ headers }) => headers.get("tailscale-user-login") ? { login: headers.get("tailscale-user-login")! } : null },
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    cleanups.push(async () => {
      sockets.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing server address")
    const base = `ws://127.0.0.1:${address.port}/rubato/api/v1/terminal`

    const ownerTicket = () => terminalTickets.issue({ origin: ORIGIN, ownerLogin: OWNER, zmxName: ZMX_NAME })
    const originBound = ownerTicket()
    await expectRejected(`${base}?ticket=${originBound.ticket}&zmxName=${ZMX_NAME}&cols=80&rows=24`, "https://evil.example", OWNER)

    const ownerBound = ownerTicket()
    await expectRejected(`${base}?ticket=${ownerBound.ticket}&zmxName=${ZMX_NAME}&cols=80&rows=24`, ORIGIN, "attacker@example.com")

    const expired = ownerTicket()
    now += 30_001
    await expectRejected(`${base}?ticket=${expired.ticket}`, ORIGIN, OWNER)

    const issued = ownerTicket()
    expect(terminalTickets.peek(issued.ticket, ORIGIN)).toEqual({ origin: ORIGIN, ownerLogin: OWNER, zmxName: ZMX_NAME })
    const opened = backend.nextOpen()
    const socket = await connect(`${base}?ticket=${issued.ticket}`, ORIGIN)
    const active = await bounded(opened)
    expect(backend.options).toMatchObject({ zmxBinary: "/opt/rubato/bin/zmx", zmxName: ZMX_NAME, cols: 80, rows: 24 })
    socket.send(encodeTerminalFrame({ type: "input", data: new TextEncoder().encode("pwd\r") }))
    socket.send(encodeTerminalFrame({ type: "resize", cols: 132, rows: 43 }))
    await bounded(Promise.all([active.session.input.promise, active.session.resized.promise]))
    expect(new TextDecoder().decode(active.session.inputs[0])).toBe("pwd\r")
    expect(active.session.sizes).toEqual([[132, 43]])

    const output = nextBinary(socket)
    active.handlers.output(new TextEncoder().encode("same-session-output"))
    const frame = decodeTerminalFrame(await output)
    expect(frame.type).toBe("output")
    if (frame.type !== "output") throw new Error("expected output frame")
    expect(new TextDecoder().decode(frame.data)).toBe("same-session-output")

    socket.close()
    await Promise.all([closed(socket), bounded(active.session.didClose.promise)])
    await expectRejected(`${base}?ticket=${issued.ticket}`, ORIGIN, OWNER)
  })
})

function connect(url: string, origin: string, owner?: string): Promise<WebSocket> {
  return bounded(new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin, ...(owner ? { "Tailscale-User-Login": owner } : {}) } })
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
    socket.on("error", () => undefined)
  }))
}

function expectRejected(url: string, origin: string, owner: string): Promise<void> {
  return bounded(new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin, "Tailscale-User-Login": owner } })
    socket.once("open", () => reject(new Error("upgrade unexpectedly accepted")))
    socket.once("error", () => resolve())
    socket.on("error", () => undefined)
  }))
}

function nextBinary(socket: WebSocket): Promise<Uint8Array> {
  return bounded(new Promise((resolve, reject) => {
    socket.once("message", (data, binary) => binary ? resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)) : reject(new Error("expected binary frame")))
    socket.once("error", reject)
  }))
}

function closeCode(socket: WebSocket): Promise<number> {
  return bounded(new Promise((resolve) => socket.once("close", (code) => resolve(code))))
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return bounded(new Promise((resolve) => socket.once("close", () => resolve())))
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket signal timed out")), 2_000)
      timeout.unref()
    }),
  ])
}
