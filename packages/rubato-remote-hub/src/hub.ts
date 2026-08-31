import type { BootstrapLaunchPayload, HostId, LiveSessionId, LiveSessionSummary } from "@rubato/remote-protocol"
import { REMOTE_PROTOCOL_CURRENT_VERSION, REMOTE_PROTOCOL_MIN_VERSION, zmxNameForLiveSession } from "@rubato/remote-protocol"
import type { SessionActionQueue } from "./action-queue.js"
import type { EnvironmentHandoffStore, EnvironmentVault } from "./environment.js"
import type { EventJournal } from "./journal.js"
import type { AllowedPathResolver } from "./path-security.js"
import type { ProcessController } from "./registry.js"
import {
  IDLE_SESSION_TTL_MS,
  LiveRegistry,
  STARTING_TIMEOUT_MS,
  SURFACE_STALE_MS,
  liveSessionTitle,
} from "./registry.js"
import type { SurfaceTokenStore } from "./surface-tokens.js"

export interface CreateLiveRequest {
  readonly cwd: string
  readonly name?: string
  readonly rubatoArgs?: readonly string[]
  readonly environment?: Readonly<Record<string, string>>
  readonly source: "terminal" | "mobile"
}

export interface HubLaunchRuntime {
  readonly socketPath: string
  readonly launcherPath: string
  readonly zmxBinary: string
  readonly buildId: string
}

export class RemoteHub {
  readonly registry: LiveRegistry
  readonly journal: EventJournal
  readonly actions: SessionActionQueue
  readonly #controller: ProcessController
  readonly #paths: AllowedPathResolver
  readonly #vault: EnvironmentVault
  readonly #handoffs: EnvironmentHandoffStore<BootstrapLaunchPayload>
  readonly #surfaceTokens: SurfaceTokenStore
  readonly #newLiveSessionId: () => LiveSessionId
  readonly #runtime: HubLaunchRuntime

  constructor(input: {
    registry: LiveRegistry
    journal: EventJournal
    actions: SessionActionQueue
    controller: ProcessController
    paths: AllowedPathResolver
    vault: EnvironmentVault
    handoffs: EnvironmentHandoffStore<BootstrapLaunchPayload>
    surfaceTokens: SurfaceTokenStore
    newLiveSessionId: () => LiveSessionId
    runtime?: HubLaunchRuntime
  }) {
    this.registry = input.registry
    this.journal = input.journal
    this.actions = input.actions
    this.#controller = input.controller
    this.#paths = input.paths
    this.#vault = input.vault
    this.#handoffs = input.handoffs
    this.#surfaceTokens = input.surfaceTokens
    this.#newLiveSessionId = input.newLiveSessionId
    this.#runtime = input.runtime ?? {
      socketPath: "/tmp/rubato-hub.sock",
      launcherPath: "/rubato/rubato-pi.sh",
      zmxBinary: "/rubato/zmx",
      buildId: "unknown",
    }
  }

  async start(): Promise<void> {
    await this.journal.load()
    await this.registry.rebuild(this.journal.summaries())
  }

  async create(request: CreateLiveRequest): Promise<{ process: Awaited<ReturnType<ProcessController["launch"]>>; summary: LiveSessionSummary; surfaceToken: string; launchToken: string }> {
    const cwd = await this.#paths.resolve(request.cwd, "directory")
    const environment = request.source === "mobile" ? await this.#vault.load() : sanitizeEnvironment(request.environment ?? {})
    const liveSessionId = this.#newLiveSessionId()
    const zmxName = zmxNameForLiveSession(liveSessionId)
    const surfaceToken = this.#surfaceTokens.issue(liveSessionId)
    const labels = fixedLabels(this.registry.hostId, liveSessionId, this.#runtime.buildId)
    const payload: BootstrapLaunchPayload = {
      schemaVersion: 1,
      liveSessionId,
      hostId: this.registry.hostId,
      zmxName,
      labels,
      cwd,
      argv: [...(request.rubatoArgs ?? [])],
      env: environment,
      launcherPath: this.#runtime.launcherPath,
      zmxBinary: this.#runtime.zmxBinary,
      hubSocket: this.#runtime.socketPath,
      surfaceToken,
    }
    const launchToken = this.#handoffs.issue(payload, 60_000)
    let process: Awaited<ReturnType<ProcessController["launch"]>>
    try {
      process = await this.#controller.launch({ liveSessionId, launchToken, socketPath: this.#runtime.socketPath, labels })
    } catch (error) {
      this.#handoffs.revoke(launchToken)
      throw error
    }
    if (process.zmxName !== zmxName) {
      this.#handoffs.revoke(launchToken)
      throw new Error("process controller returned mismatched zmx name")
    }
    const summary = this.registry.trackStarting(startingSummary({
      hostId: this.registry.hostId,
      liveSessionId,
      zmxName,
      cwd,
      ...(request.name === undefined ? {} : { name: request.name }),
      args: request.rubatoArgs ?? [],
      ...(process.pid === undefined ? {} : { pid: process.pid }),
      buildId: this.#runtime.buildId,
    }))
    return { process, summary, surfaceToken, launchToken }
  }

  async terminate(id: LiveSessionId, force: boolean): Promise<void> {
    const summary = this.registry.get(id)
    if (!summary) throw new Error("session_not_found")
    await this.#controller.terminate(id, force)
    this.registry.remove(id)
    await this.journal.append(id, "live.exited", { force }, true)
  }

  /**
   * Surface reported a clean shutdown (Ctrl+C / quit). Drop it from the picker
   * immediately and best-effort kill any lingering zmx process.
   */
  async noteExited(id: LiveSessionId): Promise<void> {
    this.registry.remove(id)
    await this.#controller.terminate(id, true).catch(() => {})
  }

  /**
   * Periodic inventory hygiene: stale heartbeats, vanished zmx processes, stuck
   * starts, and sessions that have sat idle past the TTL.
   */
  async maintainInventory(now = Date.now(), options: {
    staleMs?: number
    startingTimeoutMs?: number
    idleTtlMs?: number
  } = {}): Promise<{
    stale: readonly LiveSessionId[]
    missing: readonly LiveSessionId[]
    stuckStarting: readonly LiveSessionId[]
    idleExpired: readonly LiveSessionId[]
  }> {
    const staleMs = options.staleMs ?? SURFACE_STALE_MS
    const startingTimeoutMs = options.startingTimeoutMs ?? STARTING_TIMEOUT_MS
    const idleTtlMs = options.idleTtlMs ?? IDLE_SESSION_TTL_MS
    const stale = this.registry.markStale(now, staleMs)
    const discovered = await this.registry.discoveredIds()
    const missing = this.registry.pruneMissingProcesses(discovered, now, startingTimeoutMs)
    const stuckStarting = this.registry.pruneStuckStarting(now, startingTimeoutMs)
    for (const id of stuckStarting) {
      await this.#controller.terminate(id, true).catch(() => {})
    }
    const idleExpired = this.registry.idleExpired(now, idleTtlMs)
    for (const id of idleExpired) {
      await this.terminate(id, true).catch(() => {
        this.registry.remove(id)
      })
    }
    return { stale, missing, stuckStarting, idleExpired }
  }

  resolve(value: string): LiveSessionSummary {
    const compact = value.toLowerCase().replaceAll("-", "")
    const matches = this.registry.list().filter((summary) =>
      summary.liveSessionId.replaceAll("-", "").startsWith(compact) ||
      summary.zmxName?.toLowerCase().startsWith(value.toLowerCase()),
    )
    if (matches.length === 0) throw new Error("session_not_found")
    if (matches.length > 1) throw new Error("session_prefix_ambiguous")
    return matches[0]!
  }

  async saveBaseline(environment: Readonly<Record<string, string | undefined>>): Promise<string> {
    return this.#vault.save(environment)
  }

  snapshot(id: LiveSessionId): LiveSessionSummary | undefined {
    return this.registry.get(id) ?? this.journal.getSnapshot(id)?.summary
  }
}

function fixedLabels(hostId: HostId, liveSessionId: LiveSessionId, buildId: string): Readonly<Record<string, string>> {
  return {
    app: "rubato",
    rubato_protocol: String(REMOTE_PROTOCOL_CURRENT_VERSION),
    rubato_live_id: liveSessionId,
    rubato_host_id: hostId,
    rubato_build_id: buildId.replace(/[^A-Za-z0-9._-]/g, "-"),
  }
}

function startingSummary(input: {
  hostId: HostId
  liveSessionId: LiveSessionId
  zmxName: NonNullable<LiveSessionSummary["zmxName"]>
  cwd: string
  name?: string
  args: readonly string[]
  pid?: number
  buildId: string
}): LiveSessionSummary {
  const sessionFile = sessionFileFromArgs(input.args, input.cwd)
  return {
    schemaVersion: 1,
    hostId: input.hostId,
    liveSessionId: input.liveSessionId,
    zmxName: input.zmxName,
    managed: true,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    lifecycle: "starting",
    execution: "idle",
    attention: false,
    title: liveSessionTitle(input.name, input.cwd),
    cwd: input.cwd,
    createdAt: new Date().toISOString(),
    pi: sessionFile === undefined ? {} : { sessionFile },
    model: { label: "Unknown" },
    context: {},
    cache: { expired: true },
    background: { activeCount: 0, labels: [] },
    teams: { activeRunCount: 0, runningMemberCount: 0, failedMemberCount: 0 },
    build: { rubatoCommit: input.buildId, piVersion: "0.84.2", remoteProtocolMin: REMOTE_PROTOCOL_MIN_VERSION, remoteProtocolMax: REMOTE_PROTOCOL_CURRENT_VERSION },
    capabilities: [],
  }
}

function sessionFileFromArgs(args: readonly string[], cwd: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === "--session" && args[index + 1]) return new URL(args[index + 1]!, `file://${cwd.endsWith("/") ? cwd : `${cwd}/`}`).pathname
    if (argument.startsWith("--session=")) return new URL(argument.slice(10), `file://${cwd.endsWith("/") ? cwd : `${cwd}/`}`).pathname
  }
  return undefined
}

function sanitizeEnvironment(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.includes("\0") && !value.includes("\0")) result[key] = value
  }
  return result
}
