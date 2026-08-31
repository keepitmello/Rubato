import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { basename, extname, resolve, sep } from "node:path"
import { Hono, type Context } from "hono"
import { getConnInfo } from "@hono/node-server/conninfo"
import {
  actionRequestSchema,
  createLiveSessionRequestSchema,
  messagePageRequestSchema,
  messagePageResponseSchema,
  negotiateProtocolVersion,
  pairApproveRequestSchema,
  pairClaimRequestSchema,
  parseRequestedProtocolVersion,
  projectLiveSessionSummary,
  projectMessagePage,
  projectSnapshotResponse,
  pushProfileExportRequestSchema,
  pushProfileImportRequestSchema,
  pushSubscribeRequestSchema,
  REMOTE_HTTP_API_PREFIX,
  REMOTE_HTTP_ROUTES,
  REMOTE_PROTOCOL_NAME,
  SUPPORTED_PROTOCOL_RANGE,
  terminalTicketRequestSchema,
  terminateLiveSessionRequestSchema,
  webSocketTicketRequestSchema,
  type CreateLiveSessionResponse,
  type HealthResponse,
  type HostDescriptionResponse,
  type HostInventoryResponse,
  type LiveSessionId,
  type ProjectListResponse,
  type PushProfileImportResponse,
  type PushSubscribeResponse,
  type RemoteErrorCode,
  type SnapshotResponse,
  type TerminateLiveSessionResponse,
  type TicketResponse,
} from "@rubato/remote-protocol"
import type { TerminalLaunchTicketStore } from "@rubato/terminal-bridge"
import type { HostConfig } from "./config.js"
import type { RemoteHub } from "./hub.js"
import { isOwner, type IdentityVerifier, type VerifiedIdentity } from "./identity.js"
import type { PairingService } from "./pairing.js"
import type { PushProfileStore } from "./push.js"
import { SlidingWindowRateLimiter } from "./rate-limit.js"
import type { TicketStore } from "./tickets.js"

export interface HttpApiDependencies {
  readonly config: HostConfig
  readonly hub: RemoteHub
  readonly pairing: PairingService
  readonly tickets: TicketStore
  readonly terminalTickets: TerminalLaunchTicketStore
  readonly identity: IdentityVerifier
  readonly push: PushProfileStore
  readonly webRoot?: string
  readonly remoteAddress?: (context: Context) => string | undefined
}

type HttpEnvironment = { Variables: { identity: VerifiedIdentity } }

export function createHttpApp(dependencies: HttpApiDependencies): Hono<HttpEnvironment> {
  const app = new Hono<HttpEnvironment>()
  const ticketRate = new SlidingWindowRateLimiter(20, 60_000)
  const actionRate = new SlidingWindowRateLimiter(60, 60_000)
  const terminalRate = new SlidingWindowRateLimiter(3, 60_000)
  const inputRate = new SlidingWindowRateLimiter(10, 10_000)
  const pairRate = new SlidingWindowRateLimiter(10, 10 * 60_000)
  const remoteAddress = dependencies.remoteAddress ?? ((context: Context) => getConnInfo(context).remote.address)

  app.use(`${REMOTE_HTTP_API_PREFIX}/*`, async (context, next) => {
    context.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    context.header("x-content-type-options", "nosniff")
    context.header("referrer-policy", "no-referrer")
    const origin = context.req.header("origin")
    const pairingRoute = context.req.path.startsWith(`${REMOTE_HTTP_API_PREFIX}/pair/`)
    const cors = pairingRoute ? dependencies.pairing.pairingCorsHeaders(origin) : dependencies.pairing.corsHeaders(origin)
    for (const [name, value] of Object.entries(cors)) context.header(name, value)
    if (context.req.method === "OPTIONS") {
      if (Object.keys(cors).length === 0) return error(context, 403, "origin_not_paired", "Origin is not paired")
      return context.body(null, 204)
    }
    return next()
  })

  app.get(REMOTE_HTTP_ROUTES.health, (context) => context.json({ ok: true, hostId: dependencies.config.hostId } satisfies HealthResponse))

  app.post(REMOTE_HTTP_ROUTES.pairClaim, async (context) => {
    const identity = await authenticate(context, dependencies, remoteAddress)
    if (!isOwner(identity, dependencies.config.ownerLogin)) return error(context, 401, "unauthorized", "Owner identity required")
    if (!pairRate.take(identity!.login)) return error(context, 429, "busy", "Pairing rate limit exceeded")
    const origin = context.req.header("origin")
    if (!origin) return error(context, 400, "origin_not_paired", "HTTPS Origin required")
    const body = pairClaimRequestSchema.safeParse(await jsonBody(context, 4096))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid pairing claim")
    try {
      const claim = dependencies.pairing.claim(body.value.nonce, origin, identity!.login)
      for (const [name, value] of Object.entries(dependencies.pairing.pairingCorsHeaders(origin))) context.header(name, value)
      return context.json(claim)
    } catch {
      return error(context, 401, "unauthorized", "Invalid or expired pairing claim")
    }
  })

  app.post(REMOTE_HTTP_ROUTES.pairApprove, async (context) => {
    const identity = await authenticate(context, dependencies, remoteAddress)
    if (!isOwner(identity, dependencies.config.ownerLogin)) return error(context, 401, "unauthorized", "Owner identity required")
    const body = pairApproveRequestSchema.safeParse(await jsonBody(context, 4096))
    if (!body.ok) return error(context, 400, "invalid_action", "Explicit pairing confirmation required")
    try {
      const requestOrigin = context.req.header("origin")
      const origin = await dependencies.pairing.approve(body.value.claimId, identity!.login, body.value.confirmed, requestOrigin)
      for (const [name, value] of Object.entries(dependencies.pairing.corsHeaders(origin))) context.header(name, value)
      return context.json({ paired: true, origin })
    } catch {
      return error(context, 401, "unauthorized", "Invalid or expired pairing claim")
    }
  })

  app.use(`${REMOTE_HTTP_API_PREFIX}/*`, async (context, next) => {
    if (context.req.path === REMOTE_HTTP_ROUTES.health || context.req.path.startsWith(`${REMOTE_HTTP_API_PREFIX}/pair/`)) return next()
    const identity = await authenticate(context, dependencies, remoteAddress)
    if (!identity || !isOwner(identity, dependencies.config.ownerLogin)) return error(context, 401, "unauthorized", "Owner identity required")
    if (!pairedRequestOrigin(context, dependencies.pairing)) {
      return error(context, 403, "origin_not_paired", "Origin is not paired")
    }
    context.set("identity", identity)
    return next()
  })

  app.get(REMOTE_HTTP_ROUTES.host, async (context) => {
    const requested = parseRange(context.req.query("protocolMin"), context.req.query("protocolMax"))
    const local = SUPPORTED_PROTOCOL_RANGE
    const negotiation = requested ? negotiateProtocolVersion(local, requested) : { compatible: true as const, version: local.max }
    const response: HostDescriptionResponse = {
      hostId: dependencies.config.hostId,
      displayName: dependencies.config.displayName,
      ownerLogin: dependencies.config.ownerLogin,
      protocol: local,
      negotiation,
      capabilities: ["inventory", "journal-replay", "actions", "push", "multi-host"],
      pushPublicKey: await dependencies.push.vapidPublicKey(),
    }
    return context.json(response)
  })

  app.get(REMOTE_HTTP_ROUTES.inventory, (context) => {
    const version = requestedProtocolVersion(context)
    if (version === "protocol_mismatch") return error(context, 400, "protocol_mismatch", "Unsupported protocol version")
    const sessions = dependencies.hub.registry.list().map((summary) => projectLiveSessionSummary(summary, version))
    return context.json({ hostSeq: dependencies.hub.registry.hostSeq, sessions } satisfies HostInventoryResponse)
  })

  app.post(REMOTE_HTTP_ROUTES.createLiveSession, async (context) => {
    const body = createLiveSessionRequestSchema.safeParse(await jsonBody(context, 256 * 1024))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid live session request")
    try {
      const rubatoArgs = body.value.rubatoArgs ?? (body.value.initialPrompt === undefined ? undefined : [body.value.initialPrompt])
      const created = await dependencies.hub.create({
        cwd: body.value.cwd,
        source: "mobile",
        ...(body.value.name === undefined ? {} : { name: body.value.name }),
        ...(rubatoArgs === undefined ? {} : { rubatoArgs }),
      })
      const response: CreateLiveSessionResponse = { liveSessionId: created.process.liveSessionId, zmxName: created.process.zmxName }
      return context.json(response, 201)
    } catch (cause) {
      const code = cause instanceof Error && cause.message === "path_not_allowed" ? "path_not_allowed" : cause instanceof Error && cause.message.includes("launch environment") ? "environment_not_configured" : "internal_error"
      return error(context, code === "internal_error" ? 500 : 400, code, code === "path_not_allowed" ? "Working directory is not allowed" : code === "environment_not_configured" ? "Launch environment is not configured" : "Session could not be started")
    }
  })

  app.delete(REMOTE_HTTP_ROUTES.liveSession, async (context) => {
    const id = context.req.param("liveSessionId") as LiveSessionId
    const body = terminateLiveSessionRequestSchema.safeParse(await jsonBody(context, 4096))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid terminate request")
    try {
      await dependencies.hub.terminate(id, body.value.force === true)
      return context.json({ terminated: true } satisfies TerminateLiveSessionResponse)
    } catch {
      return error(context, 404, "session_not_found", "Live session not found")
    }
  })

  app.post(REMOTE_HTTP_ROUTES.webSocketTicket, async (context) => {
    const identity = context.get("identity") as VerifiedIdentity
    const body = webSocketTicketRequestSchema.safeParse(await jsonBody(context, 4096))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid ticket request")
    if (!ticketRate.take(identity.login)) return error(context, 429, "busy", "Ticket rate limit exceeded")
    return context.json(dependencies.tickets.issue(context.req.header("origin")!, identity.login))
  })

  app.post(REMOTE_HTTP_ROUTES.terminalTicket, async (context) => {
    const identity = context.get("identity") as VerifiedIdentity
    const id = context.req.param("liveSessionId") as LiveSessionId
    const body = terminalTicketRequestSchema.safeParse(await jsonBody(context, 4096))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid terminal ticket request")
    const session = dependencies.hub.registry.get(id)
    if (!session?.zmxName || !session.managed) return error(context, 404, "session_not_found", "Managed live session not found")
    if (!terminalRate.take(id)) return error(context, 429, "busy", "Terminal rate limit exceeded")
    try {
      const issued = dependencies.terminalTickets.issue({
        origin: context.req.header("origin")!,
        ownerLogin: identity.login,
        zmxName: session.zmxName,
      })
      return context.json({ ticket: issued.ticket, expiresAt: issued.expiresAt } satisfies TicketResponse)
    } catch {
      return error(context, 404, "session_not_found", "Managed live session not found")
    }
  })

  app.get(REMOTE_HTTP_ROUTES.snapshot, (context) => {
    const version = requestedProtocolVersion(context)
    if (version === "protocol_mismatch") return error(context, 400, "protocol_mismatch", "Unsupported protocol version")
    const id = context.req.param("liveSessionId") as LiveSessionId
    const snapshot = dependencies.hub.journal.getSnapshot(id)
    const summary = dependencies.hub.snapshot(id)
    if (!summary) return error(context, 404, "session_not_found", "Live session not found")
    const response: SnapshotResponse = snapshot
      ? {
          summary: snapshot.summary,
          revision: snapshot.state.revision,
          lastSeq: snapshot.lastSeq,
          entries: snapshot.state.entries,
          tree: snapshot.state.tree,
          commands: snapshot.state.commands,
          ...(snapshot.state.uiRequest === undefined ? {} : { uiRequest: snapshot.state.uiRequest }),
          ...(snapshot.state.timeline === undefined ? {} : { timeline: snapshot.state.timeline }),
        }
      : { summary, revision: 0, lastSeq: dependencies.hub.journal.lastSeq(id), entries: [], tree: [], commands: [] }
    return context.json(projectSnapshotResponse(response, version))
  })

  app.get(REMOTE_HTTP_ROUTES.messages, async (context) => {
    const version = requestedProtocolVersion(context)
    if (version === "protocol_mismatch") return error(context, 400, "protocol_mismatch", "Unsupported protocol version")
    const id = context.req.param("liveSessionId") as LiveSessionId
    const before = context.req.query("before")
    const limitQuery = context.req.query("limit")
    const parsed = messagePageRequestSchema.safeParse({
      ...(before ? { before } : {}),
      ...(limitQuery === undefined || limitQuery === "" ? {} : { limit: Number(limitQuery) }),
    })
    if (!parsed.ok) return error(context, 400, "invalid_action", "Invalid message page request")
    if (!dependencies.hub.registry.get(id) && !dependencies.hub.journal.getSnapshot(id)) {
      return error(context, 404, "session_not_found", "Live session not found")
    }
    try {
      const result = await dependencies.hub.actions.enqueue({
        protocol: REMOTE_PROTOCOL_NAME,
        requestId: randomUUID(),
        hostId: dependencies.config.hostId,
        liveSessionId: id,
        action: "conversation.page",
        payload: {
          limit: parsed.value.limit ?? 50,
          ...(parsed.value.before === undefined ? {} : { before: parsed.value.before }),
        },
      })
      const page = messagePageResponseSchema.safeParse(result.payload)
      if (!result.accepted || !page.ok) return error(context, 400, "invalid_action", "Conversation page is unavailable")
      return context.json(projectMessagePage(page.value, version))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ""
      if (message === "session_not_found") return error(context, 404, "session_not_found", "Live session not found")
      if (message.includes("timeout")) return error(context, 503, "busy", "Conversation page timed out")
      return error(context, 503, "busy", "Conversation page could not be loaded")
    }
  })

  app.post(REMOTE_HTTP_ROUTES.actions, async (context) => {
    const identity = context.get("identity") as VerifiedIdentity
    const id = context.req.param("liveSessionId") as LiveSessionId
    if (!actionRate.take(identity.login)) return error(context, 429, "busy", "Action rate limit exceeded")
    const body = await jsonBody(context, 256 * 1024)
    const parsed = actionRequestSchema.safeParse(body)
    if (!parsed.ok || parsed.value.hostId !== dependencies.config.hostId || parsed.value.liveSessionId !== id) {
      return error(context, 400, "invalid_action", "Invalid action request")
    }
    if (parsed.value.action.startsWith("input.") && !inputRate.take(id)) return error(context, 429, "busy", "Input rate limit exceeded")
    try {
      const result = await dependencies.hub.actions.enqueue(parsed.value)
      return context.json(result, 202)
    } catch (cause) {
      return error(context, cause instanceof Error && cause.message === "stale_revision" ? 409 : 503, cause instanceof Error && cause.message === "stale_revision" ? "stale_revision" : "busy", "Action could not be dispatched")
    }
  })

  app.post(REMOTE_HTTP_ROUTES.pushSubscribe, async (context) => {
    const body = pushSubscribeRequestSchema.safeParse(await jsonBody(context, 64 * 1024))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid push subscription")
    const profile = await dependencies.push.subscribe(body.value.subscription, context.req.header("origin")!)
    return context.json({ vapidPublicKey: profile.vapidPublicKey, createdAt: profile.createdAt } satisfies PushSubscribeResponse)
  })

  app.delete(`${REMOTE_HTTP_API_PREFIX}/push/subscription`, async (context) => {
    const value = await jsonBody(context, 16 * 1024)
    if (!isPushRevokeRequest(value)) return error(context, 400, "invalid_action", "Invalid push unsubscribe request")
    const revoked = await dependencies.push.revokeSubscription(value.endpoint, context.req.header("origin")!)
    return context.json({ revoked })
  })

  app.post(REMOTE_HTTP_ROUTES.pushProfileExport, async (context) => {
    const body = pushProfileExportRequestSchema.safeParse(await jsonBody(context, 16 * 1024))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid destination key")
    return context.json(await dependencies.push.exportEncrypted(body.value.destinationPublicKey))
  })

  app.post(REMOTE_HTTP_ROUTES.pushProfileImport, async (context) => {
    const body = pushProfileImportRequestSchema.safeParse(await jsonBody(context, 128 * 1024))
    if (!body.ok) return error(context, 400, "invalid_action", "Invalid encrypted profile")
    const profile = await dependencies.push.importEncrypted(body.value)
    return context.json({ imported: true, pwaOrigin: profile.pwaOrigin } satisfies PushProfileImportResponse)
  })

  app.post(REMOTE_HTTP_ROUTES.pushRotate, async (context) => context.json(await dependencies.push.rotate()))

  app.get(REMOTE_HTTP_ROUTES.projectsRecent, (context) => {
    const seen = new Set<string>()
    const projects = dependencies.hub.registry.list().flatMap((session) => {
      if (!session.cwd || seen.has(session.cwd)) return []
      seen.add(session.cwd)
      return [{ path: session.cwd, label: basename(session.cwd) || session.cwd, source: "recent" as const }]
    })
    return context.json({ projects } satisfies ProjectListResponse)
  })
  app.get(REMOTE_HTTP_ROUTES.projectsFavorites, (context) => context.json({ projects: [] } satisfies ProjectListResponse))

  app.all(`${REMOTE_HTTP_API_PREFIX}/*`, (context) => error(context, 404, "invalid_action", "Route not found"))
  if (dependencies.webRoot) {
    const webRoot = resolve(dependencies.webRoot)
    app.get("/rubato", (context) => context.redirect("/rubato/"))
    app.get("/rubato/*", async (context) => serveWebAsset(context, webRoot))
  }

  app.notFound((context) => error(context, 404, "invalid_action", "Route not found"))
  app.onError((cause, context) => cause instanceof HttpInputError
    ? error(context, cause.message === "payload_too_large" ? 413 : 400, cause.message === "payload_too_large" ? "payload_too_large" : "invalid_action", cause.message === "payload_too_large" ? "Payload is too large" : "Invalid request")
    : error(context, 500, "internal_error", "Internal error"))
  return app
}

function pairedRequestOrigin(context: Context, pairing: PairingService): string | null {
  const explicit = context.req.header("origin")
  if (explicit !== undefined) return pairing.isPaired(explicit) ? explicit : null
  const requestHost = new URL(context.req.url).host
  for (const host of [context.req.header("x-forwarded-host"), context.req.header("host"), requestHost]) {
    if (!host || host.includes(",") || host.includes("/") || host.includes("\\")) continue
    try {
      const origin = new URL(`https://${host}`).origin
      if (pairing.isPaired(origin)) return origin
    } catch {}
  }
  return null
}

async function serveWebAsset(context: Context, webRoot: string): Promise<Response> {
  let relative: string
  try {
    relative = decodeURIComponent(context.req.path.slice("/rubato/".length))
  } catch {
    return error(context, 404, "invalid_action", "Route not found")
  }
  if (relative.includes("\0") || relative.includes("\\") || relative.split("/").includes("..")) return error(context, 404, "invalid_action", "Route not found")
  const requested = resolve(webRoot, relative)
  if (requested !== webRoot && !requested.startsWith(`${webRoot}${sep}`)) return error(context, 404, "invalid_action", "Route not found")
  const candidate = await stat(requested).then((info) => info.isFile() ? requested : null).catch(() => null)
  const file = candidate ?? (extname(relative) ? null : resolve(webRoot, "index.html"))
  if (!file) return error(context, 404, "invalid_action", "Route not found")
  const bytes = await readFile(file).catch(() => null)
  if (!bytes) return error(context, 404, "invalid_action", "Route not found")
  const extension = extname(file).toLowerCase()
  const contentType = WEB_CONTENT_TYPES[extension] ?? "application/octet-stream"
  const immutable = relative.startsWith("assets/") && /-[A-Za-z0-9_-]{6,}\./.test(relative)
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": contentType,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "content-security-policy": "default-src 'self'; connect-src 'self' wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  })
}

const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
}

function isPushRevokeRequest(value: unknown): value is { endpoint: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length === 1 && entries[0]?.[0] === "endpoint" && typeof entries[0][1] === "string" && entries[0][1].startsWith("https://") && entries[0][1].length <= 8192
}

async function authenticate(context: Context, dependencies: HttpApiDependencies, remoteAddress: (context: Context) => string | undefined): Promise<VerifiedIdentity | null> {
  return dependencies.identity.verify({ headers: context.req.raw.headers, remoteAddress: remoteAddress(context) })
}

async function jsonBody(context: Context, maxBytes: number): Promise<unknown> {
  const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") throw new HttpInputError("POST requests require application/json")
  const declared = Number(context.req.header("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpInputError("payload_too_large")
  const text = await context.req.text()
  if (Buffer.byteLength(text) > maxBytes) throw new HttpInputError("payload_too_large")
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpInputError("invalid JSON")
  }
}

function error(context: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503, code: RemoteErrorCode, message: string): Response {
  return context.json({ error: { code, message, traceId: randomUUID() } }, status)
}

function requestedProtocolVersion(context: Context): number | "protocol_mismatch" {
  return parseRequestedProtocolVersion(context.req.query("protocolVersion"))
}

function parseRange(min: string | undefined, max: string | undefined): { min: number; max: number } | null {
  if (min === undefined || max === undefined) return null
  const parsed = { min: Number(min), max: Number(max) }
  return Number.isSafeInteger(parsed.min) && Number.isSafeInteger(parsed.max) && parsed.min > 0 && parsed.max >= parsed.min ? parsed : null
}

class HttpInputError extends Error {}
