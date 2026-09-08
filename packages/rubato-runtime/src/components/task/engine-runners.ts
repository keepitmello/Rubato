import type { ToolDefinition } from "@code-yeongyu/senpi"
import type { RubatoConfig, RubatoTaskSettings } from "@rubato/config-core"
import {
  BUILTIN_AGENTS,
  CURATED_READONLY_AGENT_NAMES,
  InProcessRunner,
  RpcProcessRunner,
  createInProcessManagedRunner,
  createChildResourceLoader,
  createParentRegistrySessionContext,
  createRpcManagedRunner,
  mapRubatoConfigAgents,
  parseExtensionEntries,
  buildRpcSpawn,
  type AgentDefinition,
  type ChildSpec,
  type CreateChildSession,
  type ManagedRunner,
  type RpcSpawnRuntime,
} from "@rubato/senpi-task"

import { MEMORY_APPLY_PATCH_TOOL_NAME, MEMORY_TOOL_NAME } from "../memory/tools"
import type { TaskRuntimeContext } from "./runtime-context"

// Memory tools are bound to the parent session's identity (repo commits + writer lock); a task
// child must never inherit them, so they ride the same ui-only exclusion as render-only tools.
export const TASK_CHILD_UI_ONLY_TOOL_NAMES: readonly string[] = [MEMORY_TOOL_NAME, MEMORY_APPLY_PATCH_TOOL_NAME]

export interface RunnerBuildContext {
  readonly runtime: TaskRuntimeContext
  readonly sharedParentTools: () => readonly ToolDefinition[]
  readonly settings: RubatoTaskSettings
}

export interface TaskRunnerFactories {
  readonly inProcess: (context: RunnerBuildContext) => ManagedRunner
  readonly process: (context: RunnerBuildContext) => ManagedRunner
  /** Respawn path must share the same explicit stock RPC runtime as first launch. */
  readonly rpcRespawn?: (context: Pick<RunnerBuildContext, "runtime">) => RpcProcessRunner
}

export type TaskRunnerFactoryOptions = {
  /** Explicit child process runtime. Omitted for the legacy Senpi default. */
  readonly rpcSpawnRuntime?: Partial<RpcSpawnRuntime>
  /** Narrow stock child profile: only provider-bearing extensions are forwarded to RPC children. */
  readonly stockChildProfile?: {
    readonly rpcExtensions?: readonly string[]
    readonly inProcessFactories?: readonly unknown[]
    readonly agentDir?: string
  }
  /** Explicit provider extensions for RPC children; overrides stockChildProfile when supplied. */
  readonly rpcChildExtensions?: readonly string[]
  /** Explicit in-process SDK session factory. Omitted to use senpi-task's default import. */
  readonly createInProcessSession?: CreateChildSession
  /** Optional child-safe inline extensions shared by in-process child sessions. */
  readonly childExtensionFactories?: readonly unknown[]
  /** Canonical stock ModelRuntime replacing Senpi-only authStorage/modelRegistry fields. */
  readonly stockModelRuntime?: NonNullable<ChildSpec["modelRuntime"]>
}

/**
 * Adapt the legacy child option shape to stock Pi's SDK. Stock has no
 * authStorage/modelRegistry parameters; silently dropping those without a
 * canonical ModelRuntime would change provider/auth behaviour, so fail closed.
 */
export function createStockInProcessSessionAdapter(
  createSession: CreateChildSession,
  stockModelRuntime?: TaskRunnerFactoryOptions["stockModelRuntime"],
  childExtensionFactories?: readonly unknown[],
  childAgentDir?: string,
): CreateChildSession {
  return async (options) => {
    const legacy = options as unknown as Record<string, unknown>
    const modelRuntime = stockModelRuntime ?? legacy.modelRuntime
    if (modelRuntime === undefined && (legacy.authStorage !== undefined || legacy.modelRegistry !== undefined)) {
      throw new Error("stock child requires modelRuntime when legacy authStorage/modelRegistry are present")
    }
    const normalized: Record<string, unknown> = { ...legacy }
    delete normalized.authStorage
    delete normalized.modelRegistry
    if (modelRuntime !== undefined) normalized.modelRuntime = modelRuntime
    if (childExtensionFactories !== undefined && childExtensionFactories.length > 0) {
      normalized.resourceLoader = createChildResourceLoader({
        cwd: String(normalized.cwd),
        agentDir: childAgentDir ?? String(normalized.agentDir ?? ""),
        settingsManager: normalized.settingsManager,
        extensionFactories: childExtensionFactories,
      })
    }
    return createSession(normalized as Parameters<CreateChildSession>[0])
  }
}

export function createTaskRunnerFactories(options: TaskRunnerFactoryOptions = {}): TaskRunnerFactories {
  const rpcChildExtensions = options.rpcChildExtensions ?? options.stockChildProfile?.rpcExtensions
  const childExtensionFactories = options.childExtensionFactories ?? options.stockChildProfile?.inProcessFactories
  const childAgentDir = options.stockChildProfile?.agentDir
  const createInProcessSession = options.createInProcessSession === undefined
    ? undefined
    : createStockInProcessSessionAdapter(options.createInProcessSession, options.stockModelRuntime, childExtensionFactories, childAgentDir)
  return {
    inProcess: (build) => buildInProcessRunner(build, createInProcessSession),
    process: (build) => buildProcessRunner(build, options.rpcSpawnRuntime, rpcChildExtensions),
    rpcRespawn: (build) => buildRpcProcessRunner(build, options.rpcSpawnRuntime, rpcChildExtensions),
  }
}

export const DEFAULT_RUNNER_FACTORIES: TaskRunnerFactories = createTaskRunnerFactories()

export function resolveTaskAgents(config: RubatoConfig): Readonly<Record<string, AgentDefinition>> {
  const merged: Record<string, AgentDefinition> = { ...BUILTIN_AGENTS }
  for (const [name, definition] of Object.entries(mapRubatoConfigAgents(config))) {
    merged[name] = { ...merged[name], ...definition }
  }
  for (const name of CURATED_READONLY_AGENT_NAMES) {
    const definition = merged[name]
    if (definition !== undefined) merged[name] = { ...definition, executionMode: "in-process" }
  }
  return merged
}

function buildInProcessRunner(build: RunnerBuildContext, createSession?: CreateChildSession): ManagedRunner {
  const inProcess = new InProcessRunner({
    get sharedParentTools(): readonly ToolDefinition[] {
      return build.sharedParentTools()
    },
    uiOnlyToolNames: TASK_CHILD_UI_ONLY_TOOL_NAMES,
    depthPolicy: { maxDepth: Math.max(build.settings.max_depth + 1, 1) },
    ...(createSession === undefined ? {} : { createSession }),
  })
  const context = createParentRegistrySessionContext(() => build.runtime.modelRegistry())
  return createInProcessManagedRunner(inProcess, context)
}

// One RpcProcessRunner shape for both first launch and respawn: the parent's `-e` extensions ride
// to the child, and a model the parent's live registry resolves skips the child catalog probe. The
// manager would otherwise default its respawn runner to a bare `new RpcProcessRunner()` that
// still probes, so a revived process child could hit the same probe budget the first launch avoids.
export function buildRpcProcessRunner(
  build: Pick<RunnerBuildContext, "runtime">,
  rpcSpawnRuntime?: Partial<RpcSpawnRuntime>,
  rpcChildExtensions?: readonly string[],
): RpcProcessRunner {
  return new RpcProcessRunner({
    inheritedExtensions: rpcChildExtensions ?? parseExtensionEntries(process.argv),
    parentRegistry: () => build.runtime.modelRegistry(),
    ...(rpcSpawnRuntime === undefined ? {} : { buildSpawn: (spec) => buildRpcSpawn(spec, rpcSpawnRuntime) }),
  })
}

function buildProcessRunner(
  build: RunnerBuildContext,
  rpcSpawnRuntime?: Partial<RpcSpawnRuntime>,
  rpcChildExtensions?: readonly string[],
): ManagedRunner {
  return createRpcManagedRunner(buildRpcProcessRunner(build, rpcSpawnRuntime, rpcChildExtensions))
}
