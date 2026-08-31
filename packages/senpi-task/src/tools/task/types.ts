import type { AgentHost, ModelCatalog } from "@rubato/agent-core"
import type { RubatoConfig } from "@rubato/config-core"

import type { AgentDefinition, SkillInvocationState } from "../../agents"
import type { TaskManager } from "../../manager"
import type { ResolvedModelRecord, TaskRunStats } from "../../state"
import type { TaskToolParamsStatic } from "./params"

// The narrow slice of senpi's ExtensionContext the task tool reads. ExtensionContext satisfies it
// structurally, so the tool stays testable with a tiny fake while the ToolDefinition keeps the full
// senpi context type at its execute() boundary.
export type TaskToolContext = {
  readonly cwd: string
  readonly sessionManager: { getSessionId(): string }
  readonly getPromptCacheSafeWaitSeconds?: () => number | undefined
}

// Parent-session ancestry the tool folds into the child spawn: the child's depth is the parent's
// depth + 1 and the root session is inherited. Absent ancestry means a top-level session (depth 0).
export type TaskAncestry = {
  readonly depth: number
  readonly rootSessionId: string
}

export type ResolveAncestry = (parentSessionId: string) => TaskAncestry | undefined

export type LoadedSkill = {
  readonly name: string
  readonly content: string
  readonly location?: string
}

// v1 load_skills contract: resolve named skills to SKILL.md content and expose a ready-to-prepend
// block plus which names resolved vs went missing (missing names never fail the spawn).
export type SkillResolution = {
  readonly prepend: string
  readonly resolved: readonly string[]
  readonly missing: readonly string[]
  readonly skills?: readonly LoadedSkill[]
}

export type SkillLoader = (names: readonly string[], cwd: string) => SkillResolution

export type TaskSkillSummary = {
  readonly requested: readonly string[]
  readonly resolved: readonly string[]
  readonly missing: readonly string[]
}

export type TaskCategoryInfo = {
  readonly name: string
  readonly description?: string
}

export type TaskAgentInfo = {
  readonly name: string
  readonly description?: string
}

export type TaskToolDeps = {
  readonly manager: TaskManager
  readonly rubatoConfig: RubatoConfig
  readonly agents: Readonly<Record<string, AgentDefinition>>
  readonly models?: ModelCatalog
  readonly host?: AgentHost
  readonly resolveAncestry?: ResolveAncestry
  // Session-scoped skill-invocation state for plan-gated agents (metis/momus). When absent the
  // invocation gate fails CLOSED: without a resolver there is no proof ulw-plan was invoked.
  readonly resolveSkillInvocations?: (sessionId: string) => SkillInvocationState
}

export type TaskToolMode = "spawn"

export type TaskToolDetails = {
  readonly agentId: string
  readonly status: string
  readonly mode: TaskToolMode
  readonly task_summary?: string
  readonly name?: string
  readonly category?: string
  readonly preset?: string
  readonly subagent_type?: string
  readonly execution_mode?: string
  readonly model?: string
  readonly resolved_model?: ResolvedModelRecord
  readonly fallback_attempts?: readonly ResolvedModelRecord[]
  readonly queue_position?: number
  readonly reason?: string
  readonly run_stats?: TaskRunStats
}

export type { TaskToolParamsStatic }
