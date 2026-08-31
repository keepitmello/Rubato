import type { LiveSessionId, LiveSessionSummary, ZmxName } from "@rubato/remote-protocol"

export interface DiscoveredProcess {
  readonly liveSessionId: LiveSessionId
  readonly zmxName: ZmxName
  readonly pid?: number
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
          }
        : degradedSummary(this.#hostId, process)
      rebuilt.set(process.liveSessionId, { summary })
    }
    this.#entries.clear()
    for (const [id, entry] of rebuilt) this.#entries.set(id, entry)
    this.#hostSeq++
  }

  trackStarting(summary: LiveSessionSummary): LiveSessionSummary {
    if (summary.hostId !== this.#hostId || summary.managed !== true || !summary.zmxName) throw new Error("invalid managed session")
    this.#entries.set(summary.liveSessionId, { summary })
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
    const summary: LiveSessionSummary = { ...surface.summary, lifecycle: "ready" }
    this.#entries.set(summary.liveSessionId, {
      summary,
      surfaceInstanceId: surface.surfaceInstanceId,
      lastHeartbeatAt: Date.now(),
    })
    this.#hostSeq++
    return summary
  }

  heartbeat(id: LiveSessionId, surfaceInstanceId: string, now = Date.now()): boolean {
    const entry = this.#entries.get(id)
    if (!entry || entry.surfaceInstanceId !== surfaceInstanceId) return false
    entry.lastHeartbeatAt = now
    return true
  }

  markStale(now = Date.now(), timeoutMs = 30_000): readonly LiveSessionId[] {
    const changed: LiveSessionId[] = []
    for (const [id, entry] of this.#entries) {
      if (entry.lastHeartbeatAt !== undefined && now - entry.lastHeartbeatAt > timeoutMs && entry.summary.lifecycle === "ready") {
        entry.summary = { ...entry.summary, lifecycle: "degraded" }
        changed.push(id)
      }
    }
    if (changed.length > 0) this.#hostSeq++
    return changed
  }

  remove(id: LiveSessionId): boolean {
    const deleted = this.#entries.delete(id)
    if (deleted) this.#hostSeq++
    return deleted
  }
}

function degradedSummary(hostId: string, process: DiscoveredProcess): LiveSessionSummary {
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
    title: "Rubato",
    cwd: "",
    createdAt: new Date().toISOString(),
    pi: {},
    model: { label: "Unknown" },
    context: {},
    cache: { expired: true },
    background: { activeCount: 0, labels: [] },
    teams: { activeRunCount: 0, runningMemberCount: 0, failedMemberCount: 0 },
    build: { piVersion: "unknown", remoteProtocolMin: 1, remoteProtocolMax: 1 },
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
