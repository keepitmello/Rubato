import { chmod } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import type { AddressInfo } from "node:net"
import {
  encodeFrame,
  JsonFrameDecoder,
  hubToSurfaceFrameSchema,
  negotiateProtocolVersion,
  pairingQrPayloadSchema,
  REMOTE_PROTOCOL_NAME,
  SUPPORTED_PROTOCOL_RANGE,
  surfaceToHubFrameSchema,
  type ActionRequestEnvelope,
  type ActionResultResponse,
  type BootstrapLaunchPayload,
  type HubToSurfaceFrame,
  type LiveSessionId,
  type PairingQrPayload,
} from "@rubato/remote-protocol"
import type { SurfaceActions } from "./action-queue.js"
import { ensurePrivateDirectory, removeIfPresent } from "./files.js"
import type { EnvironmentHandoffStore } from "./environment.js"
import type { RemoteHub } from "./hub.js"
import type { EventJournal } from "./journal.js"
import type { PairingService } from "./pairing.js"
import type { LiveRegistry } from "./registry.js"
import type { SurfaceReconnectCredentials } from "./surface-credentials.js"
import type { SurfaceTokenStore } from "./surface-tokens.js"

export const SURFACE_HANDSHAKE_TIMEOUT_MS = 5_000

interface Connection {
  readonly socket: Socket
  liveSessionId?: LiveSessionId
  surfaceInstanceId?: string
}

export interface LocalDoctorCheck {
  readonly id: string
  readonly status: "pass" | "fail" | "warning"
  readonly detail?: string
}

export interface LocalDoctorResult {
  readonly ok: boolean
  readonly checks: readonly LocalDoctorCheck[]
}

interface LocalControlServices {
  readonly pairing: PairingService
  readonly pairingBaseUrl?: () => Promise<string>
  readonly doctor?: () => Promise<LocalDoctorResult>
}

interface PendingAction {
  readonly resolve: (result: ActionResultResponse) => void
  readonly reject: (error: unknown) => void
  readonly timeout: NodeJS.Timeout
}

export class SurfaceSocketServer implements SurfaceActions {
  readonly #path: string
  readonly #registry: LiveRegistry
  readonly #journal: EventJournal
  readonly #tokens: SurfaceTokenStore
  readonly #handoffs: EnvironmentHandoffStore<BootstrapLaunchPayload>
  readonly #credentials: SurfaceReconnectCredentials
  readonly #connections = new Map<LiveSessionId, Connection>()
  readonly #pending = new Map<string, PendingAction>()
  readonly #handshakeTimeoutMs: number
  #server: Server | null = null
  #control: RemoteHub | null = null
  #local: LocalControlServices | null = null

  constructor(path: string, registry: LiveRegistry, journal: EventJournal, tokens: SurfaceTokenStore, handoffs: EnvironmentHandoffStore<BootstrapLaunchPayload>, credentials: SurfaceReconnectCredentials, options: { handshakeTimeoutMs?: number } = {}) {
    this.#path = path
    this.#registry = registry
    this.#journal = journal
    this.#tokens = tokens
    this.#handoffs = handoffs
    this.#credentials = credentials
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? SURFACE_HANDSHAKE_TIMEOUT_MS
  }

  setControl(control: RemoteHub, local?: LocalControlServices): void {
    this.#control = control
    this.#local = local ?? null
  }

  async listen(): Promise<void> {
    if (this.#server) throw new Error("surface socket already listening")
    await ensurePrivateDirectory(this.#path.slice(0, this.#path.lastIndexOf("/")))
    await this.#credentials.load()
    await removeIfPresent(this.#path)
    const server = createServer((socket) => this.#accept(socket))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.#path, () => {
        server.off("error", reject)
        resolve()
      })
    })
    await chmod(this.#path, 0o600)
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = null
    for (const connection of this.#connections.values()) connection.socket.destroy()
    this.#connections.clear()
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("surface server closed"))
    }
    this.#pending.clear()
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await removeIfPresent(this.#path)
  }

  dispatch(request: ActionRequestEnvelope): Promise<ActionResultResponse> {
    const connection = this.#connections.get(request.liveSessionId)
    if (!connection) return Promise.reject(new Error("session_not_found"))
    return new Promise<ActionResultResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(request.requestId)
        reject(new Error("surface action timeout"))
      }, 30_000)
      timeout.unref()
      this.#pending.set(request.requestId, { resolve, reject, timeout })
      const frame = { kind: "hub.action", protocol: REMOTE_PROTOCOL_NAME, request } satisfies HubToSurfaceFrame
      connection.socket.write(encodeFrame(frame))
    })
  }

  address(): string | AddressInfo | null {
    return this.#server?.address() ?? null
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true)
    const connection: Connection = { socket }
    const decoder = new JsonFrameDecoder()
    const handshake = setTimeout(() => socket.destroy(), this.#handshakeTimeoutMs)
    handshake.unref()
    const finishHandshake = () => clearTimeout(handshake)
    socket.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) {
          finishHandshake()
          void this.#handle(connection, frame).catch(() => socket.destroy())
        }
      } catch {
        finishHandshake()
        socket.destroy()
      }
    })
    socket.on("close", () => {
      finishHandshake()
      if (connection.liveSessionId && this.#connections.get(connection.liveSessionId) === connection) {
        this.#connections.delete(connection.liveSessionId)
      }
    })
    socket.on("error", () => {
      finishHandshake()
      socket.destroy()
    })
  }

  async #handle(connection: Connection, input: unknown): Promise<void> {
    if (isRecord(input) && typeof input["kind"] === "string" && input["kind"].startsWith("cli.")) {
      if (connection.liveSessionId) throw new Error("surface connection cannot become a control connection")
      await this.#handleControl(connection.socket, input)
      return
    }
    const frame = surfaceToHubFrameSchema.parse(input)
    if (!connection.liveSessionId) {
      if (frame.kind === "bootstrap.claim") {
        const launch = this.#handoffs.consume(frame.token)
        if (!launch) throw new Error("invalid launch token")
        const response = { kind: "hub.launch", protocol: REMOTE_PROTOCOL_NAME, launch } satisfies HubToSurfaceFrame
        connection.socket.end(encodeFrame(response))
        return
      }
      if (frame.kind !== "surface.register") throw new Error("surface must register first")
      const bootstrapValid = typeof frame.token === "string" && this.#tokens.consume(frame.summary.liveSessionId, frame.token)
      const reconnectValid = typeof frame.reconnectToken === "string" && this.#credentials.verify(frame.reconnectToken, frame.summary.liveSessionId, frame.surfaceInstanceId)
      if (!bootstrapValid && !reconnectValid) throw new Error("invalid surface credential")
      this.#registry.register({ summary: frame.summary, surfaceInstanceId: frame.surfaceInstanceId, token: "verified" }, "verified")
      connection.liveSessionId = frame.summary.liveSessionId
      connection.surfaceInstanceId = frame.surfaceInstanceId
      this.#connections.get(connection.liveSessionId)?.socket.destroy()
      this.#connections.set(connection.liveSessionId, connection)
      const protocolRange = SUPPORTED_PROTOCOL_RANGE
      const response = {
        kind: "hub.registered",
        protocol: REMOTE_PROTOCOL_NAME,
        hostSeq: this.#registry.hostSeq,
        reconnectToken: this.#credentials.issue(connection.liveSessionId, connection.surfaceInstanceId),
        protocolRange,
        negotiation: negotiateProtocolVersion(protocolRange, frame.protocolRange),
      } satisfies HubToSurfaceFrame
      connection.socket.write(encodeFrame(response))
      return
    }
    switch (frame.kind) {
      case "surface.heartbeat":
        if (frame.surfaceInstanceId !== connection.surfaceInstanceId || !this.#registry.heartbeat(connection.liveSessionId, frame.surfaceInstanceId)) throw new Error("stale surface")
        return
      case "surface.event": {
        if (frame.liveSessionId !== connection.liveSessionId || frame.surfaceInstanceId !== connection.surfaceInstanceId) throw new Error("invalid surface event")
        await this.#journal.append(connection.liveSessionId, frame.type, frame.payload, shouldFlush(frame.type))
        if (frame.type === "live.exited") {
          await this.#control?.noteExited(connection.liveSessionId)
          connection.socket.destroy()
          return
        }
        if (frame.type === "session.changed") {
          const name = sessionChangedName(frame.payload)
          if (name) this.#registry.updateTitle(connection.liveSessionId, name)
        }
        if (frame.type === "agent.state") {
          const execution = agentStateExecution(frame.payload)
          if (execution) this.#registry.noteExecution(connection.liveSessionId, execution)
        }
        return
      }
      case "surface.snapshot": {
        if (frame.summary.liveSessionId !== connection.liveSessionId || frame.surfaceInstanceId !== connection.surfaceInstanceId) throw new Error("invalid surface snapshot")
        this.#registry.register({ summary: frame.summary, surfaceInstanceId: frame.surfaceInstanceId, token: "registered" }, "registered")
        await this.#journal.snapshot(frame.summary, frame.state)
        return
      }
      case "surface.summary": {
        if (frame.summary.liveSessionId !== connection.liveSessionId || frame.surfaceInstanceId !== connection.surfaceInstanceId) throw new Error("invalid surface summary")
        this.#registry.register({ summary: frame.summary, surfaceInstanceId: frame.surfaceInstanceId, token: "registered" }, "registered")
        return
      }
      case "surface.action-result": {
        const pending = this.#pending.get(frame.requestId)
        if (!pending) return
        this.#pending.delete(frame.requestId)
        clearTimeout(pending.timeout)
        pending.resolve({ accepted: frame.accepted, revision: frame.revision, payload: frame.payload })
        return
      }
      case "bootstrap.claim":
      case "surface.register":
        throw new Error("surface already registered")
      default:
        throw new Error("unknown surface frame")
    }
  }

  async #handleControl(socket: Socket, frame: Record<string, unknown>): Promise<void> {
    const requestId = typeof frame["requestId"] === "string" ? frame["requestId"] : "invalid"
    const control = this.#control
    if (!control) {
      socket.end(encodeFrame({ kind: "hub.control-result", protocol: REMOTE_PROTOCOL_NAME, requestId, ok: false, error: "hub_not_ready" }))
      return
    }
    try {
      let result: unknown
      switch (frame["kind"]) {
        case "cli.health":
          result = { healthy: true, hostId: this.#registry.hostId }
          break
        case "cli.list":
          result = { hostSeq: this.#registry.hostSeq, sessions: this.#registry.list() }
          break
        case "cli.resolve":
          if (typeof frame["value"] !== "string") throw new Error("invalid_request")
          result = { session: control.resolve(frame["value"]) }
          break
        case "cli.create": {
          if (typeof frame["cwd"] !== "string" || !isStringArray(frame["rubatoArgs"]) || !isStringRecord(frame["environment"])) throw new Error("invalid_request")
          if (frame["name"] !== undefined && typeof frame["name"] !== "string") throw new Error("invalid_request")
          const created = await control.create({
            cwd: frame["cwd"],
            source: "terminal",
            rubatoArgs: frame["rubatoArgs"],
            environment: frame["environment"],
            ...(typeof frame["name"] === "string" ? { name: frame["name"] } : {}),
          })
          result = { session: created.summary }
          break
        }
        case "cli.kill":
          if (typeof frame["value"] !== "string" || typeof frame["force"] !== "boolean") throw new Error("invalid_request")
          await control.terminate(control.resolve(frame["value"]).liveSessionId, frame["force"])
          result = { terminated: true }
          break
        case "cli.environment.save":
          if (!isOptionalStringRecord(frame["environment"])) throw new Error("invalid_request")
          result = { hash: await control.saveBaseline(frame["environment"]) }
          break
        case "cli.status":
          result = { healthy: true, hostId: this.#registry.hostId, hostSeq: this.#registry.hostSeq }
          break
        case "cli.add-host": {
          if (!this.#local?.pairing || !this.#local.pairingBaseUrl) throw new Error("pairing_not_configured")
          const baseUrl = await this.#local.pairingBaseUrl().catch(() => { throw new Error("pairing_not_configured") })
          const issued = this.#local.pairing.issueNonce(10 * 60 * 1000)
          const pairing: PairingQrPayload = pairingQrPayloadSchema.parse({
            type: "rubato-host-pair",
            baseUrl,
            hostId: this.#registry.hostId,
            nonce: issued.nonce,
            expiresAt: issued.expiresAt,
          })
          const qrPayload = JSON.stringify(pairing)
          const separator = pairing.baseUrl.includes("?") ? "&" : "?"
          result = { pairing, url: `${pairing.baseUrl}${separator}pair=${Buffer.from(qrPayload).toString("base64url")}`, qrPayload }
          break
        }
        case "cli.doctor":
          if (!this.#local?.doctor) throw new Error("doctor_unavailable")
          result = await this.#local.doctor()
          break
        default:
          throw new Error("unknown_control_request")
      }
      socket.end(encodeFrame({ kind: "hub.control-result", protocol: REMOTE_PROTOCOL_NAME, requestId, ok: true, result }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error"
      const safe = ["invalid_request", "session_not_found", "session_prefix_ambiguous", "path_not_allowed", "environment_not_configured", "pairing_not_configured", "doctor_unavailable", "unknown_control_request"].includes(message) ? message : "internal_error"
      socket.end(encodeFrame({ kind: "hub.control-result", protocol: REMOTE_PROTOCOL_NAME, requestId, ok: false, error: safe }))
    }
  }
}

export function validateHubActionFrame(frame: unknown): ActionRequestEnvelope | null {
  const parsed = hubToSurfaceFrameSchema.safeParse(frame)
  return parsed.ok && parsed.value.kind === "hub.action" ? parsed.value.request : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 256 && value.every((entry) => typeof entry === "string" && entry.length <= 16_384)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([key, entry]) => key.length <= 256 && typeof entry === "string")
}

function isOptionalStringRecord(value: unknown): value is Record<string, string | undefined> {
  return isRecord(value) && Object.entries(value).every(([key, entry]) => key.length <= 256 && (entry === undefined || typeof entry === "string"))
}

function shouldFlush(type: unknown): boolean {
  return type === "action.completed" || type === "action.rejected" || type === "agent.state" || type === "live.exited"
}

function sessionChangedName(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const direct = payload["name"]
  if (typeof direct === "string" && direct.trim()) return direct.trim()
  const event = payload["event"]
  if (isRecord(event) && typeof event["name"] === "string" && event["name"].trim()) return event["name"].trim()
  return undefined
}

function agentStateExecution(payload: unknown): "working" | "idle" | undefined {
  if (!isRecord(payload)) return undefined
  const execution = payload["execution"]
  return execution === "working" || execution === "idle" ? execution : undefined
}
