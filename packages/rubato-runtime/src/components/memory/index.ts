import type { RubatoMemorySettings } from "@rubato/config-core"
import { resolveMemoryIdentity } from "@rubato/memory-core"

import type { ComponentContext, RubatoComponent, SenpiExtensionAPI } from "../../extension/types"
import { loadSenpiRubatoConfig, type SenpiRubatoConfigResult } from "../config-resolution"
import {
  MEMORY_BINDING_CUSTOM_TYPE,
  createMemoryBinding,
  findLatestMemoryBinding,
  type SessionEntryLike,
} from "./binding"
import { renderMemoryBindingEntry } from "./bindings/entry-renderer"
import { hasMemoryCapabilities, missingMemoryCapabilities } from "./capabilities"
import { createMemoryIdentityContext, type MemoryIdentityContext } from "./context"
import { shutdownDeadlineAt, type ShutdownReason } from "./shutdown-drain"
import { resolveMemorySettings } from "./identity-runtime"
import { memoryModuleSupervisor } from "./supervisor"
import { createMemoryWiring, type MemoryWiringOptions } from "./wiring"

const GLOBAL_DISABLED_FLAG = "rubato-disabled"
const MEMORY_DISABLED_FLAG = "rubato-memory-disabled"

export type ResolvedMemoryConfig = RubatoMemorySettings

export interface MemoryComponentOptions {
  readonly env?: Record<string, string | undefined>
  readonly loadConfig?: (options?: { readonly cwd?: string }) => SenpiRubatoConfigResult
  readonly now?: () => number
  readonly resolveCwd?: () => string
  readonly createRuntime?: MemoryWiringOptions["createRuntime"]
  readonly refreshStatus?: MemoryWiringOptions["refreshStatus"]
}

type SessionUi = { notify(message: string, level: "error" | "warning"): void }
type SessionSurface = {
  readonly entries: readonly SessionEntryLike[]
  readonly id: string
  readonly ui?: SessionUi
}
type SessionState = {
  readonly enabled: boolean
  readonly ui?: SessionUi
  context?: MemoryIdentityContext
  memoryStatusAttempted: boolean
}

export { MEMORY_BINDING_CUSTOM_TYPE } from "./binding"
export { ensureIdentityRuntimeDirs, getMemoryRepo } from "./context"
export type { MemoryIdentityContext, MemoryPendingLedger, MemoryRepoAccess } from "./context"
export { memoryModuleSupervisor } from "./supervisor"

export function createMemoryComponent(options: MemoryComponentOptions = {}): RubatoComponent {
  const loadConfig = options.loadConfig ?? loadSenpiRubatoConfig
  const resolveCwd = options.resolveCwd ?? (() => process.cwd())
  const now = options.now ?? Date.now
  const env = options.env ?? process.env
  const sessions = new Map<string, SessionState>()

  return {
    name: "memory",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const cwd = resolveCwd()
      const bootConfig = resolveMemoryConfig(loadConfig({ cwd }))
      if (!isEnabled(bootConfig, ctx, env)) return

      const missing = missingMemoryCapabilities(pi)
      if (missing.length > 0 || !hasMemoryCapabilities(pi)) {
        ctx.logger.warn("Rubato memory component skipped: missing ExtensionAPI capabilities", { missing })
        return
      }

      const wiring = createMemoryWiring({
        sessions,
        loadConfig,
        cwd: resolveCwd,
        env,
        now,
        logger: ctx.logger,
        ...(options.createRuntime === undefined ? {} : { createRuntime: options.createRuntime }),
        ...(options.refreshStatus === undefined ? {} : { refreshStatus: options.refreshStatus }),
        // Reuse the boot snapshot: registration must not add a loadConfig() call, because the
        // enablement latch depends on the ORDER of reads across boot -> session_start -> reload.
        toolExposure: bootConfig.tool_exposure,
      })
      wiring.registerStatic(pi, ctx)
      pi.registerEntryRenderer(MEMORY_BINDING_CUSTOM_TYPE, renderMemoryBindingEntry)
      pi.on("session_start", (_payload, eventCtx) => {
        const surface = readSessionSurface(eventCtx)
        wiring.clearStatus(eventCtx)
        const sessionConfig = resolveMemoryConfig(loadConfig({ cwd }))
        const enabled = isEnabled(sessionConfig, ctx, env)
        releaseSession(sessions.get(surface.id))
        const state: SessionState = {
          enabled,
          memoryStatusAttempted: false,
          ...(surface.ui === undefined ? {} : { ui: surface.ui }),
        }
        sessions.set(surface.id, state)
        if (!enabled) return

        const identity = resolveMemoryIdentity(sessionConfig.agent, cwd, env)
        const previous = findLatestMemoryBinding(surface.entries)
        if (previous !== undefined && previous.identity !== identity.id) {
          surface.ui?.notify(
            `memory identity conflict: session is bound to ${previous.identity}, but config resolved ${identity.id}; restart with the original identity or fork a new session`,
            "error",
          )
          return
        }

        const binding = createMemoryBinding({ identity: identity.id, repoPath: identity.paths.repo, boundAt: now() })
        state.context = createMemoryIdentityContext({
          identity: identity.id,
          identityPaths: identity.paths,
          binding,
        })
        memoryModuleSupervisor.acquire()
        pi.appendEntry(MEMORY_BINDING_CUSTOM_TYPE, binding)
        // Bind-time reconcile floats past session_start by design, but its rejection must not
        // float: an unhandled rejection is attributed to whatever code is running when it lands.
        void wiring.afterBind(pi, surface.id, state.context, eventCtx).catch((error: unknown) => {
          ctx.logger.warn("memory bind-time reconcile failed", { error: String(error) })
        })
      })

      pi.on("session_shutdown", async (payload, eventCtx) => {
        const sessionId = readSessionSurface(eventCtx).id
        // The drain runs BEFORE the session is released: its steps read the bound identity.
        await wiring.onSessionShutdown({
          reason: readShutdownReason(payload),
          sessionId,
          deadlineAt: shutdownDeadlineAt(now),
          now,
        })
        wiring.clearStatus(eventCtx)
        releaseSession(sessions.get(sessionId))
        sessions.delete(sessionId)
      })
    },
  }
}

export function resolveMemoryConfig(loaded: SenpiRubatoConfigResult): ResolvedMemoryConfig {
  return resolveMemorySettings(loaded.config.memory)
}

// A memory child carries one of these sentinels. Today the child also runs --no-extensions, so Rubato
// never loads there; a fork-mode child cannot pass --no-extensions (its request prefix must match
// the parent for the provider cache to hit), so the sentinel is the only thing standing between a
// forked reflection and unbounded self-triggering recursion.
const CHILD_SENTINELS = ["SENPI_MEMORY_REFLECTION", "SENPI_MEMORY_FACTS"] as const

export function isMemoryChildProcess(env: Record<string, string | undefined>): boolean {
  return CHILD_SENTINELS.some((sentinel) => env[sentinel] === "1")
}

function isEnabled(
  config: ResolvedMemoryConfig,
  ctx: ComponentContext,
  env: Record<string, string | undefined>,
): boolean {
  return config.enabled
    && !isMemoryChildProcess(env)
    && ctx.config.getFlag(GLOBAL_DISABLED_FLAG) !== true
    && ctx.config.getFlag(MEMORY_DISABLED_FLAG) !== true
}

function releaseSession(state: SessionState | undefined): void {
  if (state?.context === undefined) return
  memoryModuleSupervisor.release()
  state.context = undefined
}

function readSessionSurface(value: unknown): SessionSurface {
  if (!isRecord(value)) return { entries: [], id: "unknown-session" }
  const manager = isRecord(value.sessionManager) ? value.sessionManager : undefined
  const getSessionId = manager?.getSessionId
  const getEntries = manager?.getEntries
  const id = typeof getSessionId === "function" ? Reflect.apply(getSessionId, manager, []) : "unknown-session"
  const entries = typeof getEntries === "function" ? Reflect.apply(getEntries, manager, []) : []
  const ui = isSessionUi(value.ui) ? value.ui : undefined
  return {
    entries: Array.isArray(entries) ? entries : [],
    id: typeof id === "string" && id.length > 0 ? id : "unknown-session",
    ...(ui === undefined ? {} : { ui }),
  }
}

function isSessionUi(value: unknown): value is SessionUi {
  return isRecord(value) && typeof value.notify === "function"
}

const SHUTDOWN_REASONS: readonly ShutdownReason[] = ["quit", "reload", "new", "resume", "fork"]

/** An unknown or absent reason drains conservatively: flush and enqueue, launch nothing. */
function readShutdownReason(payload: unknown): ShutdownReason {
  if (!isRecord(payload)) return "reload"
  const reason = payload.reason
  return SHUTDOWN_REASONS.find((candidate) => candidate === reason) ?? "reload"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
