import {
  availableProductModelIds,
  productCatalogIdentity,
  resolveModelEffort,
  type EffortSource,
} from "@rubato/model-core"
import {
  resolveAgent,
  type AgentDefinition,
  type ChildPlanner,
  type PlanResolution,
  type ResolvedAgentResult,
  type SenpiModelPort,
  type SenpiModelRegistryPort,
} from "@rubato/task"

type ResolvedPlan = Extract<PlanResolution, { readonly kind: "resolved" }>["plan"]
type ResolvedModelMetadata = NonNullable<ResolvedPlan["resolved_model"]>

export type { EffortSource }

// The live senpi model registry surface the planner needs. ExtensionContext.modelRegistry satisfies
// it structurally; a fake with getAvailable/find satisfies it in tests.
export type TaskModelRegistry = SenpiModelRegistryPort<SenpiModelPort>

export type ResolveModelRegistry = () => TaskModelRegistry | undefined

const NO_REGISTRY_MESSAGE = "No model registry is available yet to resolve a task model."

export function plannedEffortSource(model: ResolvedModelMetadata | undefined): EffortSource | undefined {
  const source = model?.effortSource
  return source === "model-default" || source === "manual-override" ? source : undefined
}

export function createTaskChildPlanner(
  agents: Readonly<Record<string, AgentDefinition>>,
  resolveRegistry: ResolveModelRegistry,
): ChildPlanner {
  return (spec): PlanResolution => {
    if (spec.preset !== undefined) {
      const agentResolution = resolveAgentTarget(spec.preset, spec.model, agents, resolveRegistry)
      if (agentResolution !== undefined) return withReasoningPolicy(agentResolution, spec.reasoning)
    }

    if (spec.preset === undefined && spec.model !== undefined && spec.model.length > 0) {
      return withReasoningPolicy(resolveExactModel(spec.model, resolveRegistry), spec.reasoning)
    }
    return { kind: "error", error: { code: "invalid_target", message: "A task requires a model or preset." } }
  }
}

function withReasoningPolicy(resolution: PlanResolution, reasoning: string | undefined): PlanResolution {
  if (resolution.kind !== "resolved") return resolution
  const explicit = reasoning !== undefined && reasoning.length > 0 ? reasoning : undefined
  const applyRecord = (model: ResolvedModelMetadata): ResolvedModelMetadata => {
    const applied = resolveModelEffort(`${model.provider}/${model.model_id}`, explicit)
    if (applied === undefined) return model
    return {
      ...model,
      reasoning: applied.effort,
      reasoning_effort: applied.effort,
      effortSource: applied.effortSource,
    }
  }
  const { plan } = resolution
  const applied = resolveModelEffort(plan.model, explicit)
  const { variant: _unusedVariant, ...rest } = plan
  return {
    kind: "resolved",
    plan: {
      ...rest,
      ...(plan.resolved_model !== undefined ? { resolved_model: applyRecord(plan.resolved_model) } : {}),
      ...(plan.requested_model !== undefined ? { requested_model: applyRecord(plan.requested_model) } : {}),
      ...(plan.fallback_models !== undefined
        ? { fallback_models: plan.fallback_models.map(applyRecord) }
        : {}),
      ...(applied !== undefined ? { variant: applied.effort } : {}),
    },
  }
}

function resolveAgentTarget(
  agentName: string,
  explicitModel: string | undefined,
  agents: Readonly<Record<string, AgentDefinition>>,
  resolveRegistry: ResolveModelRegistry,
): PlanResolution | undefined {
  const definition = Object.hasOwn(agents, agentName) ? agents[agentName] : undefined
  if (definition?.disable === true) {
    if (explicitModel === undefined || explicitModel.length === 0) return undefined
    return {
      kind: "error",
      error: {
        code: "unknown_target",
        message: `Target "${agentName}" not found.`,
        availableAgents: listAvailableAgents(agents),
      },
    }
  }

  if (explicitModel !== undefined && explicitModel.length > 0) {
    const exact = resolveExactModel(explicitModel, resolveRegistry)
    if (exact.kind === "error") return exact
    const resolution = resolveAgent(agentName, agents, undefined, { modelOverride: explicitModel })
    if (resolution.kind !== "resolved") return undefined
    return { kind: "resolved", plan: toAgentPlan(resolution, exact.plan.resolved_model) }
  }

  const registry = resolveRegistry()
  const scoped = registry === undefined ? undefined : productScopedRegistry(registry)
  const resolution = resolveAgent(agentName, agents, scoped)
  if (resolution.kind === "resolved") {
    const exact = resolveExactModel(resolution.model, resolveRegistry)
    if (exact.kind === "error") return exact
    return { kind: "resolved", plan: toAgentPlan({ ...resolution, model: exact.plan.model }, exact.plan.resolved_model) }
  }
  if (resolution.kind === "model_unavailable") {
    if (registry === undefined) {
      return { kind: "error", error: { code: "model_unavailable", message: NO_REGISTRY_MESSAGE } }
    }
    return {
      kind: "error",
      error: {
        code: "model_unavailable",
        message: `No available model for agent "${agentName}" (attempted ${resolution.attemptedModel ?? "none"}).`,
        availableAgents: resolution.availableAgents,
      },
    }
  }
  return undefined
}

function toAgentPlan(resolution: ResolvedAgentResult, explicitModel: ResolvedModelMetadata | undefined): ResolvedPlan {
  const resolvedModel = resolution.resolved_model ?? explicitModel
  return {
    model: resolution.model,
    ...(resolution.requested_model !== undefined
      ? { requested_model: resolution.requested_model }
      : {}),
    ...(resolution.fallback_models !== undefined
      ? { fallback_models: resolution.fallback_models }
      : {}),
    ...(resolvedModel !== undefined ? { resolved_model: resolvedModel } : {}),
    preset: resolution.preset,
    ...(resolution.instructions !== undefined ? { instructions: resolution.instructions } : {}),
    ...(resolution.toolAllowlist !== undefined ? { toolAllowlist: resolution.toolAllowlist } : {}),
    ...(resolution.agentExecutionMode !== undefined ? { agentExecutionMode: resolution.agentExecutionMode } : {}),
    ...(resolution.allowedSubagents !== undefined ? { allowedSubagents: resolution.allowedSubagents } : {}),
    ...(resolution.maxDepth !== undefined ? { maxDepth: resolution.maxDepth } : {}),
  }
}

function listAvailableAgents(agents: Readonly<Record<string, AgentDefinition>>): readonly string[] {
  return Object.entries(agents)
    .filter(([, definition]) => definition.disable !== true)
    .map(([name]) => name)
    .sort()
}

function explicitModelMetadata(model: string): ResolvedModelMetadata | undefined {
  const separatorIndex = model.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    return undefined
  }
  return {
    source: "explicit",
    provider: model.slice(0, separatorIndex),
    model_id: model.slice(separatorIndex + 1),
    display: model,
  }
}

function productScopedRegistry(registry: TaskModelRegistry): TaskModelRegistry {
  const admitted = (): ReadonlySet<string> => {
    try {
      const available = registry.getAvailable()
      if (!Array.isArray(available)) return new Set()
      return new Set(availableProductModelIds(available))
    } catch {
      return new Set()
    }
  }
  return {
    getAvailable: () => {
      try {
        const available = registry.getAvailable()
        if (!Array.isArray(available)) return []
        const allowed = admitted()
        return available.filter((entry) => {
          if (typeof entry?.provider !== "string" || typeof entry.id !== "string") return false
          return allowed.has(productCatalogIdentity(`${entry.provider}/${entry.id}`))
        })
      } catch {
        return []
      }
    },
    find: (provider, modelId) => {
      if (!admitted().has(productCatalogIdentity(`${provider}/${modelId}`))) return undefined
      return registry.find(provider, modelId)
    },
  }
}

function pickerVisible(registry: TaskModelRegistry, provider: string, modelId: string): boolean {
  try {
    const available = registry.getAvailable()
    if (!Array.isArray(available)) return false
    return availableProductModelIds(available).includes(productCatalogIdentity(`${provider}/${modelId}`))
  } catch {
    return false
  }
}

function resolveExactModel(model: string, resolveRegistry: ResolveModelRegistry): PlanResolution {
  const metadata = explicitModelMetadata(productCatalogIdentity(model))
  if (metadata === undefined) {
    return {
      kind: "error",
      error: {
        code: "invalid_target",
        message: `Model "${model}" is not a complete provider/model identifier.`,
      },
    }
  }
  const registry = resolveRegistry()
  if (registry === undefined) {
    return { kind: "error", error: { code: "model_unavailable", message: NO_REGISTRY_MESSAGE } }
  }
  if (!pickerVisible(registry, metadata.provider, metadata.model_id)) {
    return {
      kind: "error",
      error: {
        code: "model_unavailable",
        message: `No available model "${model}".`,
      },
    }
  }
  return {
    kind: "resolved",
    plan: {
      model: `${metadata.provider}/${metadata.model_id}`,
      resolved_model: metadata,
    },
  }
}
