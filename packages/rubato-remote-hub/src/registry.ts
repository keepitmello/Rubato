import { basename } from "node:path"
import type { LiveSessionId, LiveSessionSummary, ZmxName } from "@rubato/remote-protocol"
import { REMOTE_PROTOCOL_CURRENT_VERSION, REMOTE_PROTOCOL_MIN_VERSION } from "@rubato/remote-protocol"

/** Heartbeat silence before a ready surface is marked degraded. */
export const SURFACE_STALE_MS = 30_000
/** Starting sessions that never register are dropped after this. */
export const STARTING_TIMEOUT_MS = 120_000
/** Idle (post-turn) sessions leave the picker after this quiet period. */
export const IDLE_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export interface DiscoveredProcess {
  readonly liveSessionId: LiveSessionId
  readonly zmxName: ZmxName
  readonly pid?: number
  readonly cwd?: string
  readonly name?: string
  readonly labels: Readonly<Record<string, string>>
}

export interface ProcessDiscovery {
  discover(): Promise<readonly DiscoveredProcess[]>
}

export interface ProcessController {
  launch(input: LaunchRequest): Promise<DiscoveredProcess>
  terminate(liveSessionId: LiveSessionId, force: boolean): Promise<void>
}

export interface LaunchRequest {
  readonly liveSessionId: LiveSessionId
  readonly launchToken: string
  readonly socketPath: string
  readonly labels: Readonly<Record<string, string>>
}

export interface RegisteredSurface {
  readonly surfaceInstanceId: string
  readonly token: string
  readonly summary: LiveSessionSummary
}

interface RegistryEntry {
  summary: LiveSessionSummary
  surfaceInstanceId?: string
  lastHeartbeatAt?: number
  /** Wall-clock ms of last create/register/heartbeat/snapshot activity. */
  lastActivityAt: number
  /** When the current idle stretch began; cleared while execution is working. */
  idleSinceAt?: number
}

export function liveSessionTitle(name?: string, cwd?: string, fallback = ""): string {
  const explicit = name?.trim() ?? ""
  const folder = basename(cwd ?? "").trim()
  const usableFolder = folder && folder !== "/" && folder !== "." ? folder : ""
  return explicit || usableFolder || fallback
}

export class LiveRegistry {
  readonly #hostId: string
  readonly #discovery: ProcessDiscovery
  readonly #entries = new Map<LiveSessionId, RegistryEntry>()
  #hostSeq = 0

  constructor(hostId: string, discovery: ProcessDiscovery) {
    this.#hostId = hostId
    this.#discovery = discovery
  }

  get hostId(): LiveSessionSummary["hostId"] {
    return this.#hostId as LiveSessionSummary["hostId"]
  }

  get hostSeq(): number {
    return this.#hostSeq
  }

  list(): readonly LiveSessionSummary[] {
    return [...this.#entries.values()].map(({ summary }) => summary).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async discoveredIds(): Promise<ReadonlySet<LiveSessionId>> {
    const discovered = await this.#discovery.discover()
    return new Set(
      discovered
        .filter((process) => process.labels["app"] === "rubato" && process.labels["rubato_live_id"] === process.liveSessionId)
        .map((process) => process.liveSessionId),
    )
  }

  get(id: LiveSessionId): LiveSessionSummary | undefined {
    return this.#entries.get(id)?.summary
  }

  async rebuild(previous: readonly LiveSessionSummary[] = []): Promise<void> {
    const previousById = new Map(previous.map((summary) => [summary.liveSessionId, summary]))
    const discovered = await this.#discovery.discover()
    const rebuilt = new Map<LiveSessionId, RegistryEntry>()
    for (const process of discovered) {
      if (process.labels["app"] !== "rubato" || process.labels["rubato_live_id"] !== process.liveSessionId) continue
      const old = previousById.get(process.liveSessionId)
      const summary: LiveSessionSummary = old
        ? {
            ...old,
            zmxName: process.zmxName,
            ...(process.pid === undefined ? (old.pid === undefined ? {} : { pid: old.pid }) : { pid: process.pid }),
            managed: true,
            lifecycle: "degraded",
            title: liveSessionTitle(old.title, old.cwd),
          }
        : degradedSummary(this.#hostId, process)
      const now = Date.now()
      rebuilt.set(process.liveSessionId, {
        summary,
        lastActivityAt: Date.parse(summary.createdAt) || now,
        idleSinceAt: now,
      })
    }
    this.#entries.clear()
    for (const [id, entry] of rebuilt) this.#entries.set(id, entry)
    this.#hostSeq++
  }

  trackStarting(summary: LiveSessionSummary): LiveSessionSummary {
    if (summary.hostId !== this.#hostId || summary.managed !== true || !summary.zmxName) throw new Error("invalid managed session")
    const now = Date.now()
    this.#entries.set(summary.liveSessionId, { summary, lastActivityAt: now, idleSinceAt: now })
    this.#hostSeq++
    return summary
  }

  register(surface: RegisteredSurface, expectedToken: string): LiveSessionSummary {
    if (!constantTimeEqual(surface.token, expectedToken)) throw new Error("invalid surface token")
    if (surface.summary.hostId !== this.#hostId) throw new Error("surface host mismatch")
    const existing = this.#entries.get(surface.summary.liveSessionId)
    if (existing?.summary.zmxName && surface.summary.zmxName !== existing.summary.zmxName) {
      throw new Error("surface zmx identity mismatch")
    }
    const summary: LiveSessionSummary = {
      ...surface.summary,
      lifecycle: "ready",
      title: liveSessionTitle(surface.summary.title, surface.summary.cwd),
    }
    const now = Date.now()
    const previous = this.#entries.get(summary.liveSessionId)
    let idleSinceAt: number | undefined
    if (summary.execution === "working") {
      idleSinceAt = undefined
    } else if (previous?.summary.execution === "working" || previous?.idleSinceAt === undefined) {
      idleSinceAt = now
    } else {
      idleSinceAt = previous.idleSinceAt
    }
    this.#entries.set(summary.liveSessionId, {
      summary,
      surfaceInstanceId: surface.surfaceInstanceId,
      lastHeartbeatAt: now,
      lastActivityAt: now,
      ...(idleSinceAt === undefined ? {} : { idleSinceAt }),
    })
    this.#hostSeq++
    return summary
  }

  heartbeat(id: LiveSessionId, surfaceInstanceId: string, now = Date.now()): boolean {
    const entry = this.#entries.get(id)
    if (!entry || entry.surfaceInstanceId !== surfaceInstanceId) return false
    entry.lastHeartbeatAt = now
    entry.lastActivityAt = now
    return true
  }

  /** Keep picker titles in sync with the Pi session / terminal tab name. */
  updateTitle(id: LiveSessionId, title: string, now = Date.now()): boolean {
    const entry = this.#entries.get(id)
    if (!entry) return false
    const explicit = title.trim()
    if (!explicit) return false
    const next = liveSessionTitle(explicit, entry.summary.cwd, entry.summary.zmxName)
    if (next === entry.summary.title) return false
    entry.summary = { ...entry.summary, title: next }
    entry.lastActivityAt = now
    this.#hostSeq++
    return true
  }

  noteExecution(id: LiveSessionId, execution: LiveSessionSummary["execution"], now = Date.now()): void {
    const entry = this.#entries.get(id)
    if (!entry) return
    const previous = entry.summary.execution
    if (previous === execution) {
      entry.lastActivityAt = now
      return
    }
    entry.summary = { ...entry.summary, execution }
    entry.lastActivityAt = now
    if (execution === "working") {
      delete entry.idleSinceAt
    } else {
      entry.idleSinceAt = now
    }
    this.#hostSeq++
  }

  markStale(now = Date.now(), timeoutMs = SURFACE_STALE_MS): readonly LiveSessionId[] {
    const changed: LiveSessionId[] = []
    for (const [id, entry] of this.#entries) {
      if (entry.lastHeartbeatAt !== undefined && now - entry.lastHeartbeatAt > timeoutMs && entry.summary.lifecycle === "ready") {
        entry.summary = { ...entry.summary, lifecycle: "degraded" }
        entry.idleSinceAt ??= now
        changed.push(id)
      }
    }
    if (changed.length > 0) this.#hostSeq++
    return changed
  }

  /**
   * Drop managed sessions whose zmx process is gone. Starting entries keep a short
   * grace window so create→discover races do not flicker the picker.
   */
  pruneMissingProcesses(discoveredIds: ReadonlySet<LiveSessionId>, now = Date.now(), startingGraceMs = STARTING_TIMEOUT_MS): readonly LiveSessionId[] {
    const removed: LiveSessionId[] = []
    for (const [id, entry] of this.#entries) {
      if (!entry.summary.managed || !entry.summary.zmxName) continue
      if (discoveredIds.has(id)) continue
      // Ready surfaces leave via live.exited / idle TTL. Only reap sessions that are
      // already degraded or stuck starting so a flaky `zmx list` cannot wipe the picker.
      if (entry.summary.lifecycle === "ready") continue
      if (entry.summary.lifecycle === "starting" && now - entry.lastActivityAt < startingGraceMs) continue
      this.#entries.delete(id)
      removed.push(id)
    }
    if (removed.length > 0) this.#hostSeq++
    return removed
  }

  /** Starting sessions that never become ready. */
  pruneStuckStarting(now = Date.now(), timeoutMs = STARTING_TIMEOUT_MS): readonly LiveSessionId[] {
    const removed: LiveSessionId[] = []
    for (const [id, entry] of this.#entries) {
      if (entry.summary.lifecycle !== "starting") continue
      if (now - entry.lastActivityAt < timeoutMs) continue
      this.#entries.delete(id)
      removed.push(id)
    }
    if (removed.length > 0) this.#hostSeq++
    return removed
  }

  /**
   * Sessions that finished a turn (or never got one) and stayed quiet for the TTL.
   * Returns ids the hub should terminate + remove from the picker.
   */
  idleExpired(now = Date.now(), ttlMs = IDLE_SESSION_TTL_MS): readonly LiveSessionId[] {
    const expired: LiveSessionId[] = []
    for (const [id, entry] of this.#entries) {
      if (entry.summary.execution === "working") continue
      const assistantAt = Date.parse(entry.summary.lastAssistantAt ?? "")
      const since = entry.idleSinceAt
        ?? (Number.isFinite(assistantAt) ? assistantAt : undefined)
        ?? entry.lastActivityAt
      if (now - since >= ttlMs) expired.push(id)
    }
    return expired
  }

  remove(id: LiveSessionId): boolean {
    const deleted = this.#entries.delete(id)
    if (deleted) this.#hostSeq++
    return deleted
  }
}

function degradedSummary(hostId: string, process: DiscoveredProcess): LiveSessionSummary {
  const cwd = process.cwd ?? ""
  return {
    schemaVersion: 1,
    hostId: hostId as LiveSessionSummary["hostId"],
    liveSessionId: process.liveSessionId,
    zmxName: process.zmxName,
    managed: true,
    ...(process.pid === undefined ? {} : { pid: process.pid }),
    lifecycle: "degraded",
    execution: "idle",
    attention: false,
    title: liveSessionTitle(process.name, cwd, process.zmxName),
    cwd,
    createdAt: new Date().toISOString(),
    pi: {},
    model: { label: "Unknown" },
    context: {},
    cache: { expired: true },
    background: { activeCount: 0, labels: [] },
    teams: { activeRunCount: 0, runningMemberCount: 0, failedMemberCount: 0 },
    build: { piVersion: "unknown", remoteProtocolMin: REMOTE_PROTOCOL_MIN_VERSION, remoteProtocolMax: REMOTE_PROTOCOL_CURRENT_VERSION },
    capabilities: [],
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!
  return difference === 0
}
