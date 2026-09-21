import { MemoryBlockCache } from "@rubato/memory-core"

import type { ComponentContext, SenpiExtensionAPI } from "../../extension/types"
import { createDreamTriggerWiring, resolveDreamTriggerSettings } from "./dream-trigger"
import { resolveMemorySettings } from "./identity-runtime"
import { createMemoryNudgeWiring } from "./nudge-wiring"
import { registerMemoryFilesystemPolicy } from "./policy-guard"
import { createShutdownDrain, type ShutdownDrainInput, type ShutdownEvaluator } from "./shutdown-drain"
import { type SkillsUsageTracker } from "./skills-usage"
import { type MemoryUsageTracker } from "./memory-usage"
import { createMemoryNoticeWiring } from "./memory-notice-wiring"
import { branchEntryCount } from "./wiring-context"
import {
  createMemoryReflectionLiveWiring,
  createReflectionCompletionApi,
} from "./wiring-reflection-live"
import { createMemoryRuntimeWiring, type MemoryRuntimeWiring } from "./wiring-runtime"
import { registerMemoryStatic } from "./wiring-static"
import type { MemoryCommandSettings } from "./commands/types"
import type { MemoryWiring, MemoryWiringOptions } from "./wiring-types"

export type { MemorySessionStateLike, MemoryWiring, MemoryWiringOptions } from "./wiring-types"

export function createMemoryWiring(options: MemoryWiringOptions): MemoryWiring {
  const promptCache = new MemoryBlockCache()
  const lastEventCtx: { current?: unknown } = {}
  const activeSession: { current?: string } = {}
  // Bind-time disk reconciliation outlives session_start. Its continuation must
  // not attach UI/workers to a session that has already shut down or rebound.
  const bindings = new Map<string, symbol>()
  const skillsUsageTrackersRef: { current: Map<string, SkillsUsageTracker> } = { current: new Map() }
  const memoryUsageTrackersRef: { current: Map<string, MemoryUsageTracker> } = { current: new Map() }
  const reflectionLive = createMemoryReflectionLiveWiring(options, activeSession, lastEventCtx)
  const runtimeWiring = createMemoryRuntimeWiring(
    options,
    lastEventCtx,
    reflectionLive.currentSession,
    {
      onLaunch: reflectionLive.onReflectionLaunched,
      onLiveCompletion: reflectionLive.onLiveReflectionCompleted,
    },
  )
  const { resolveContext, journalWiringFor, runtimeFor } = runtimeWiring

  const nudgeWiring = createMemoryNudgeWiring({
    resolveContext,
    resolveSettings: (identity) => {
      const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
      const override = settings.agents[identity]?.nudge
      return {
        enabled: override?.enabled ?? settings.nudge.enabled,
        everyUserTurns: override?.every_user_turns ?? settings.nudge.every_user_turns,
      }
    },
  })
  const noticeWiring = createMemoryNoticeWiring({
    resolveContext,
    resolveEditNotice: (identity) => {
      const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
      const override = settings.agents[identity]?.soul
      return override?.edit_notice ?? settings.soul.edit_notice
    },
    resolveWriteNotice: (identity) => {
      // Presentation must never depend on config health, matching the direct surface's gate:
      // an unreadable config keeps the default on.
      try {
        const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
        const override = settings.agents[identity]?.write_notice
        return override?.enabled ?? settings.write_notice.enabled
      } catch {
        return true
      }
    },
  })

  async function flushSkillsUsageTrackers(signal?: AbortSignal): Promise<void> {
    for (const tracker of skillsUsageTrackersRef.current.values()) {
      if (signal?.aborted === true) return
      await tracker.flush(signal)
    }
    for (const tracker of memoryUsageTrackersRef.current.values()) {
      if (signal?.aborted === true) return
      await tracker.flush(signal)
    }
  }

  const shutdownDrain = createShutdownDrain({
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    steps: {
      flushJournal: async (sessionId, signal) => {
        const identity = resolveContext(sessionId)
        if (identity === undefined) return
        await journalWiringFor(identity).journalFor(sessionId).flush(signal)
      },
      flushSkillsUsage: async (_sessionId, signal) => {
        if (signal.aborted) return
        await flushSkillsUsageTrackers(signal)
      },
    },
  })

  const dreamTriggerWiring = buildDreamTriggerWiring(options, runtimeWiring, activeSession)
  shutdownDrain.registerEvaluator(dreamTriggerWiring.shutdownEvaluator())

  function loadCommandSettings(): MemoryCommandSettings {
    const resolved = options.loadConfig({ cwd: options.cwd() }).config
    return { settings: resolveMemorySettings(resolved.memory) }
  }

  return {
    registerStatic(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      reflectionLive.registerRpc(pi, resolveContext)
      registerMemoryStatic({
        pi,
        ctx,
        options,
        promptCache,
        nudgeWiring,
        noticeWiring,
        dreamTriggerWiring,
        completionApi: createReflectionCompletionApi,
        resolveContext,
        journalWiringFor,
        runtimeFor,
        triggerSessionFor: runtimeWiring.triggerSessionFor,
        loadCommandSettings,
        lastEventCtx,
        activeSession,
        skillsUsageTrackersRef,
        memoryUsageTrackersRef,
        onReflectionLaunch: reflectionLive.onReflectionLaunched,
        onSettled: reflectionLive.onSettled,
        onMemoryWrite: reflectionLive.syncRpc,
      })
    },

    async afterBind(pi, sessionId, identity, eventCtx): Promise<void> {
      const binding = Symbol(sessionId)
      bindings.set(sessionId, binding)
      const isCurrent = () => bindings.get(sessionId) === binding
      activeSession.current = sessionId
      lastEventCtx.current = eventCtx
      reflectionLive.attach(sessionId)
      registerMemoryFilesystemPolicy(pi, identity)
      await runtimeFor(identity).reconcile()
      if (!isCurrent()) return
      if (branchEntryCount(eventCtx) > 0) {
        await journalWiringFor(identity).reconcileSession(eventCtx)
      }
      if (!isCurrent()) return
      await reflectionLive.bind(
        pi,
        sessionId,
        identity,
        eventCtx,
        () => {
          void dreamTriggerWiring.requestPressureDream(sessionId).catch((error: unknown) => {
            options.logger?.warn("rubato-runtime memory pressure dream trigger failed", { error: describe(error) })
          })
        },
      )
    },

    async flushSkillsUsage(): Promise<void> {
      await flushSkillsUsageTrackers()
    },

    async onSessionShutdown(input: ShutdownDrainInput): Promise<void> {
      bindings.delete(input.sessionId)
      reflectionLive.shutdown(options.sessions.get(input.sessionId)?.context?.identity)
      await shutdownDrain.run(input)
    },

    registerShutdownEvaluator(evaluator: ShutdownEvaluator): void {
      shutdownDrain.registerEvaluator(evaluator)
    },

    clearStatus(eventCtx: unknown): void {
      reflectionLive.clearStatus(eventCtx)
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildDreamTriggerWiring(
  options: MemoryWiringOptions,
  runtimeWiring: MemoryRuntimeWiring,
  activeSession: { current?: string },
) {
  return createDreamTriggerWiring({
    resolveSession: (eventCtx) => runtimeWiring.dreamSessionFor(eventCtx),
    resolveActiveSession: () => activeSession.current === undefined
      ? undefined
      : runtimeWiring.dreamSessionById(activeSession.current),
    resolveSessionById: runtimeWiring.dreamSessionById,
    resolveSettings: (identity) => {
      const settings = resolveMemorySettings(options.loadConfig({ cwd: options.cwd() }).config.memory)
      return resolveDreamTriggerSettings(settings, identity)
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}
