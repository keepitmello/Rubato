import type { Server as HttpServer, IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import { clientResumeSchema, REMOTE_HTTP_ROUTES } from "@rubato/remote-protocol"
import {
  createTerminalBackend,
  TerminalBridgeController,
  type TerminalBackend,
  type TerminalLaunchTicketStore,
} from "@rubato/terminal-bridge"
import type { EventJournal } from "./journal.js"
import { isOwner, type IdentityVerifier } from "./identity.js"
import type { PairingService } from "./pairing.js"
import type { TicketStore } from "./tickets.js"

export class HubWebSocketServer {
  readonly #server: HttpServer
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false })
  readonly #terminalWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false })
  readonly #identity: IdentityVerifier
  readonly #ownerLogin: string
  readonly #pairing: PairingService
  readonly #tickets: TicketStore
  readonly #journal: EventJournal
  readonly #terminalTickets: TerminalLaunchTicketStore
  readonly #terminalBackend: TerminalBackend
  readonly #zmxBinary: string
  readonly #terminalOpens = new WeakMap<IncomingMessage, { ticket: string; origin: string; ownerLogin: string; zmxName: string; cols: number; rows: number }>()
  readonly #clients = new Set<WebSocket>()
  readonly #heartbeat: NodeJS.Timeout

  constructor(input: {
    server: HttpServer
    identity: IdentityVerifier
    ownerLogin: string
    pairing: PairingService
    tickets: TicketStore
    journal: EventJournal
    terminalTickets: TerminalLaunchTicketStore
    zmxBinary: string
    terminalBackend?: TerminalBackend
  }) {
    this.#server = input.server
    this.#identity = input.identity
    this.#ownerLogin = input.ownerLogin
    this.#pairing = input.pairing
    this.#tickets = input.tickets
    this.#journal = input.journal
    this.#terminalTickets = input.terminalTickets
    this.#terminalBackend = input.terminalBackend ?? createTerminalBackend({ selection: "bun" })
    this.#zmxBinary = input.zmxBinary
    this.#server.on("upgrade", (request, socket, head) => void this.#upgrade(request, (socket as Socket).remoteAddress).then((route) => {
      if (!route) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
        socket.destroy()
        return
      }
      const target = route === "events" ? this.#wss : this.#terminalWss
      target.handleUpgrade(request, socket, head, (client) => target.emit("connection", client, request))
    }).catch((cause) => {
      console.error(`rubato remote WebSocket upgrade failed: ${cause instanceof Error ? cause.message : "unknown error"}`)
      socket.destroy()
    }))
    this.#wss.on("connection", (socket) => this.#connect(socket))
    this.#terminalWss.on("connection", (socket, request) => void this.#connectTerminal(socket, request))
    this.#heartbeat = setInterval(() => {
      for (const socket of this.#clients) {
        const state = socket as WebSocket & { alive?: boolean }
        if (state.alive === false) socket.terminate()
        else {
          state.alive = false
          socket.ping()
        }
      }
    }, 30_000)
    this.#heartbeat.unref()
  }

  broadcast(value: unknown): void {
    const encoded = JSON.stringify(value)
    for (const socket of this.#clients) if (socket.readyState === WebSocket.OPEN) socket.send(encoded)
  }

  close(): void {
    clearInterval(this.#heartbeat)
    for (const socket of this.#clients) socket.close(1001, "hub stopping")
    this.#wss.close()
    this.#terminalWss.close()
  }

  async #upgrade(request: IncomingMessage, remoteAddress: string | undefined): Promise<"events" | "terminal" | null> {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : null
    if (!this.#pairing.isPaired(origin)) return null
    const identity = await this.#identity.verify({ headers: new Headers(flattenHeaders(request)), remoteAddress })
    if (identity && !isOwner(identity, this.#ownerLogin)) return null
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const ticket = url.searchParams.get("ticket")
    if (!ticket) return null
    if (url.pathname === REMOTE_HTTP_ROUTES.webSocket) {
      const ticketOwner = this.#tickets.consumeForUpgrade(ticket, origin!)
      return ticketOwner === this.#ownerLogin && (!identity || identity.login === ticketOwner) ? "events" : null
    }
    if (url.pathname !== REMOTE_HTTP_ROUTES.terminalWebSocket) return null
    const launch = this.#terminalTickets.peek(ticket, origin!)
    if (!launch || launch.ownerLogin !== this.#ownerLogin || (identity && identity.login !== launch.ownerLogin)) return null
    const requestedCols = Number(url.searchParams.get("cols"))
    const requestedRows = Number(url.searchParams.get("rows"))
    const cols = Number.isSafeInteger(requestedCols) && requestedCols > 0 ? requestedCols : 80
    const rows = Number.isSafeInteger(requestedRows) && requestedRows > 0 ? requestedRows : 24
    this.#terminalOpens.set(request, { ticket, ...launch, cols, rows })
    return "terminal"
  }

  async #connectTerminal(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const open = this.#terminalOpens.get(request)
    if (!open) return socket.close(1008, "unauthorized")
    const controller = new TerminalBridgeController({
      backend: this.#terminalBackend,
      sink: {
        send: (frame) => new Promise<void>((resolve, reject) => socket.send(frame, { binary: true }, (error) => error ? reject(error) : resolve())),
        close: () => { if (socket.readyState === WebSocket.OPEN) socket.close(1000) },
      },
    })
    socket.once("close", () => {
      try { controller.finishInput() } catch { /* controller closes its attach client */ }
      void controller.close()
    })
    socket.once("error", () => void controller.close())
    try {
      await controller.openAuthorized({ ...open, zmxBinary: this.#zmxBinary }, this.#terminalTickets)
    } catch {
      socket.close(1008, "invalid terminal ticket")
      return
    }
    socket.on("message", (data, binary) => {
      if (!binary) return socket.close(1003, "binary terminal frames required")
      try { controller.receive(rawDataBuffer(data)) } catch { socket.close(1007, "invalid terminal frame") }
    })
  }

  #connect(socket: WebSocket): void {
    const state = socket as WebSocket & { alive?: boolean }
    state.alive = true
    this.#clients.add(socket)
    socket.on("pong", () => { state.alive = true })
    socket.on("close", () => this.#clients.delete(socket))
    socket.on("message", (data, binary) => {
      if (binary || rawDataSize(data) > 256 * 1024) return socket.close(1009, "payload too large")
      let input: unknown
      try {
        input = JSON.parse(rawDataBuffer(data).toString()) as unknown
      } catch {
        return socket.close(1007, "invalid JSON")
      }
      const resume = clientResumeSchema.safeParse(input)
      if (!resume.ok) return socket.close(1007, "invalid resume request")
      for (const session of resume.value.sessions) {
        const replay = this.#journal.replay(session.liveSessionId, session.lastSeq)
        if (replay.type === "events") {
          for (const event of replay.events) socket.send(JSON.stringify(event))
        } else {
          socket.send(JSON.stringify({ type: "snapshot.required", liveSessionId: session.liveSessionId, snapshot: replay.snapshot }))
        }
      }
    })
  }
}

function rawDataSize(data: RawData): number {
  return Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

function flattenHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[name] = value
    else if (Array.isArray(value)) headers[name] = value.join(", ")
  }
  return headers
}
