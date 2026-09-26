import { RubatoMemorySettingsSchema, type RubatoMemorySettings } from "@rubato/config-core"
import { recordStoreRoot, resolveMemoryRoot, resolveProjectStore } from "@rubato/memory-core"

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
import { registerMemoryRepositoryCommand } from "./commands/memory-repository"
import { createMemoryIdentityContext, type MemoryIdentityContext } from "./context"
import { createDreamLauncher, type DreamLauncher } from "./dream-launch"
import { registerMemoryGuard } from "./guard"
import { registerMemoryFilesystemPolicy } from "./policy-guard"
import {
  RESIDENT_ENTRY_TYPE,
  ensureSelfRepo,
  readResidentBlock,
  recordedResidentSnapshot,
  withResidentBlock,
  type ResidentSnapshot,
} from "./prompt"
import {
  MEMORY_APPLY_PATCH_TOOL_NAME,
  MEMORY_MCP_APPLY_PATCH_TOOL_NAME,
  MEMORY_MCP_TOOL_NAME,
  MEMORY_TOOL_NAME,
} from "./tool-metadata"
import { registerMemoryToolSurface } from "./tools"
import { isRecord, sessionIdFrom } from "./wiring-context"

const GLOBAL_DISABLED_FLAG = "rubato-disabled"
const MEMORY_DISABLED_FLAG = "rubato-memory-disabled"

export type ResolvedMemoryConfig = RubatoMemorySettings

export interface MemoryComponentOptions {
  readonly env?: Record<string, string | undefined>
  readonly loadConfig?: (options?: { readonly cwd?: string }) => SenpiRubatoConfigResult
  readonly now?: () => number
  readonly resolveCwd?: () => string
  /** Starts `rubato dream --due` in the background; tests inject a recorder. */
  readonly dreamLauncher?: DreamLauncher
}

type SessionUi = { notify(message: string, level: "error" | "warning"): void }
type SessionSurface = {
  readonly entries: readonly SessionEntryLike[]
  readonly id: string
  readonly ui?: SessionUi
  readonly hasUI: boolean
}
type SessionState = {
  context?: MemoryIdentityContext
  resident?: ResidentSnapshot
}

export { MEMORY_BINDING_CUSTOM_TYPE } from "./binding"
export { ensureIdentityRuntimeDirs } from "./context"
export type { MemoryIdentityContext } from "./context"

export function createMemoryComponent(options: MemoryComponentOptions = {}): RubatoComponent {
  const loadConfig = options.loadConfig ?? loadSenpiRubatoConfig
  const resolveCwd = options.resolveCwd ?? (() => process.cwd())
  const now = options.now ?? Date.now
  const env = options.env ?? process.env

  return {
    name: "memory",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const cwd = resolveCwd()
      const bootConfig = resolveMemoryConfig(loadConfig({ cwd }))
      if (!isEnabled(bootConfig, ctx)) return

      const missing = missingMemoryCapabilities(pi)
      if (missing.length > 0 || !hasMemoryCapabilities(pi)) {
        ctx.logger.warn("Rubato memory component skipped: missing ExtensionAPI capabilities", { missing })
        return
      }

      const sessions = new Map<string, SessionState>()
      let activeSession: string | undefined
      const activeContext = () => (activeSession === undefined ? undefined : sessions.get(activeSession)?.context)
      const contextFor = (eventCtx: unknown) => {
        const id = sessionIdFrom(eventCtx)
        return id === undefined ? undefined : sessions.get(id)?.context
      }
      const memoryRoot = resolveMemoryRoot(env, cwd)
      const dream = options.dreamLauncher ?? createDreamLauncher({
        env,
        now,
        log: (message, details) => ctx.logger.warn(message, details),
      })
      // Only a session a person is at asks for the dream: print-mode workers (`rubato dispatch`) and
      // hosts without a UI would otherwise fire it once per worker.
      const launchDream = (reason: string, surface: SessionSurface) => {
        if (surface.hasUI) dream.launch(reason)
      }

      pi.registerEntryRenderer(MEMORY_BINDING_CUSTOM_TYPE, renderMemoryBindingEntry)
      pi.registerEntryRenderer(RESIDENT_ENTRY_TYPE, renderMemoryBindingEntry)

      // Boot snapshot: tool registration must not re-read config.
      registerMemoryToolSurface(pi, activeContext, { exposure: bootConfig.tool_exposure })
      pi.on("tool_call", (payload, eventCtx) => {
        if (!isRecord(payload) || !isMemoryToolName(payload.toolName) || !isRecord(payload.input)) return
        const sessionId = sessionIdFrom(eventCtx)
        const context = contextFor(eventCtx)
        if (sessionId === undefined || context === undefined) {
          // Never trust model-supplied provenance: it would pick the store the write lands in.
          delete payload.input.provenance
          return
        }
        payload.input.provenance = {
          sessionId,
          identityId: context.identity,
          repoPath: context.identityPaths.repo,
          ...(context.root === undefined ? {} : { root: context.root }),
          home: context.home === true,
        }
      })
      registerMemoryGuard(pi, ctx, { getContext: contextFor, resolveCwd })
      registerMemoryRepositoryCommand(pi, { contextForSession: (sessionId) => sessions.get(sessionId)?.context })

      pi.on("system_prompt", (payload, eventCtx) => {
        if (!isRecord(payload) || typeof payload.systemPrompt !== "string") return undefined
        const id = sessionIdFrom(eventCtx)
        const resident = id === undefined ? undefined : sessions.get(id)?.resident
        const systemPrompt = withResidentBlock(payload.systemPrompt, resident)
        return systemPrompt === undefined ? undefined : { systemPrompt }
      })

      pi.on("session_start", (_payload, eventCtx) => {
        const surface = readSessionSurface(eventCtx)
        const sessionConfig = resolveMemoryConfig(loadConfig({ cwd }))
        sessions.delete(surface.id)
        if (!isEnabled(sessionConfig, ctx)) return
        const state: SessionState = {}
        sessions.set(surface.id, state)
        activeSession = surface.id

        state.resident = recordedResidentSnapshot(surface.entries) ?? { block: readResidentBlock(memoryRoot) }
        if (recordedResidentSnapshot(surface.entries) === undefined && state.resident.block !== "") {
          pi.appendEntry(RESIDENT_ENTRY_TYPE, state.resident)
        }
        void ensureSelfRepo(memoryRoot).catch((error: unknown) => {
          ctx.logger.warn("memory self store could not be created", { error: String(error) })
        })
        launchDream("session_start", surface)

        // Named by config, by the git project root, or the home directory; anywhere else there is no
        // store. Binding creates nothing: the store directory appears with the first memory write.
        const identity = resolveProjectStore(sessionConfig.agent, cwd, { env })
        if (identity === undefined) return
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
          ...(identity.root === undefined ? {} : { root: identity.root }),
          home: identity.home,
        })
        // An existing store learns a root it is now used from; a new one waits for its first write.
        try {
          recordStoreRoot(identity)
        } catch (error) {
          ctx.logger.warn("memory store.json could not be updated", { error: String(error) })
        }
        pi.appendEntry(MEMORY_BINDING_CUSTOM_TYPE, binding)
        registerMemoryFilesystemPolicy(pi, state.context)
      })

      pi.on("session_shutdown", (_payload, eventCtx) => {
        const surface = readSessionSurface(eventCtx)
        if (sessions.has(surface.id)) launchDream("session_end", surface)
        sessions.delete(surface.id)
        if (activeSession === surface.id) activeSession = undefined
      })
    },
  }
}

export function resolveMemoryConfig(loaded: SenpiRubatoConfigResult): ResolvedMemoryConfig {
  return loaded.config.memory ?? RubatoMemorySettingsSchema.parse({})
}

function isEnabled(config: ResolvedMemoryConfig, ctx: ComponentContext): boolean {
  return config.enabled
    && ctx.config.getFlag(GLOBAL_DISABLED_FLAG) !== true
    && ctx.config.getFlag(MEMORY_DISABLED_FLAG) !== true
}

function isMemoryToolName(value: unknown): boolean {
  return value === MEMORY_TOOL_NAME
    || value === MEMORY_APPLY_PATCH_TOOL_NAME
    || value === MEMORY_MCP_TOOL_NAME
    || value === MEMORY_MCP_APPLY_PATCH_TOOL_NAME
}

function readSessionSurface(value: unknown): SessionSurface {
  if (!isRecord(value)) return { entries: [], id: "unknown-session", hasUI: false }
  const manager = isRecord(value.sessionManager) ? value.sessionManager : undefined
  const getEntries = manager?.getEntries
  const entries = typeof getEntries === "function" ? Reflect.apply(getEntries, manager, []) : []
  const ui = isSessionUi(value.ui) ? value.ui : undefined
  return {
    entries: Array.isArray(entries) ? entries : [],
    id: sessionIdFrom(value) ?? "unknown-session",
    hasUI: value.hasUI === true,
    ...(ui === undefined ? {} : { ui }),
  }
}

function isSessionUi(value: unknown): value is SessionUi {
  return isRecord(value) && typeof value.notify === "function"
}
