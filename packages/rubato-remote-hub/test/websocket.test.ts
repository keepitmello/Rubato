import { afterEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { TerminalLaunchTicketStore, type TerminalBackend } from "@rubato/terminal-bridge"
import { createServer } from "node:http"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import { EventJournal } from "../src/journal.js"
import { PairingService } from "../src/pairing.js"
import { TicketStore } from "../src/tickets.js"
import { HubWebSocketServer } from "../src/websocket.js"
import { HOST_ID, SESSION_ID, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("WebSocket ticket API", () => {
  test("authenticates the paired owner, consumes the ticket, and replays journal events", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const pairing = new PairingService(join(temporary.path, "origins.json"))
    await pairing.load()
    const nonce = pairing.issueNonce()
    const claim = pairing.claim(nonce.nonce, "https://phone.example.ts.net", "owner@example.com")
    await pairing.approve(claim.claimId, "owner@example.com", true)
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID)
    await journal.load()
    await journal.append(SESSION_ID, "session.changed", { revision: 1 }, true)
    const tickets = new TicketStore()
    const server = createServer((_request, response) => { response.writeHead(404).end() })
    const websocketServer = new HubWebSocketServer({
      server,
      ownerLogin: "owner@example.com",
      pairing,
      tickets,
      journal,
      terminalTickets: new TerminalLaunchTicketStore(),
      zmxBinary: "/opt/rubato/zmx",
      terminalBackend: { open: async () => { throw new Error("unused") } } satisfies TerminalBackend,
      identity: { verify: async ({ headers }) => headers.get("tailscale-user-login") === "owner@example.com" ? { login: "owner@example.com" } : null },
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    cleanups.push(async () => {
      websocketServer.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing server address")
    const issued = tickets.issue("https://phone.example.ts.net", "owner@example.com")
    const socket = await connect(address.port)
    const upgraded = nextData(socket)
    socket.write([
      `GET /rubato/api/v1/ws?ticket=${issued.ticket} HTTP/1.1`,
      `Host: 127.0.0.1:${address.port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "Origin: https://phone.example.ts.net",
      "Tailscale-User-Login: owner@example.com",
      "\r\n",
    ].join("\r\n"))
    expect((await upgraded).toString()).toStartWith("HTTP/1.1 101")
    expect(tickets.consume(issued.ticket, "https://phone.example.ts.net", "owner@example.com")).toBeFalse()

    const replay = nextData(socket)
    socket.write(clientTextFrame(JSON.stringify({ type: "client.resume", sessions: [{ liveSessionId: SESSION_ID, lastSeq: 0 }] })))
    const replayed = JSON.parse(serverTextFrame(await replay)) as Record<string, unknown>
    expect(replayed).toMatchObject({ liveSessionId: SESSION_ID, seq: 1, type: "session.changed" })
    socket.destroy()
  })
})

function connect(port: number): Promise<Socket> {
  return bounded(new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.once("connect", () => resolve(socket))
    socket.once("error", reject)
  }))
}

function nextData(socket: Socket): Promise<Buffer> {
  return bounded(new Promise((resolve, reject) => {
    socket.once("data", (data) => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data)))
    socket.once("error", reject)
  }))
}

function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  if (payload.length >= 126) throw new Error("test payload unexpectedly large")
  const mask = Buffer.from([1, 2, 3, 4])
  const frame = Buffer.alloc(2 + 4 + payload.length)
  frame[0] = 0x81
  frame[1] = 0x80 | payload.length
  mask.copy(frame, 2)
  for (let index = 0; index < payload.length; index++) frame[6 + index] = payload[index]! ^ mask[index % 4]!
  return frame
}

function serverTextFrame(frame: Buffer): string {
  const lengthCode = frame[1]! & 0x7f
  const offset = lengthCode === 126 ? 4 : 2
  const length = lengthCode === 126 ? frame.readUInt16BE(2) : lengthCode
  return frame.subarray(offset, offset + length).toString("utf8")
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("socket signal timed out")), 2_000)
      timeout.unref()
    }),
  ])
}
