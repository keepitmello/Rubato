import { resolveModelEffort } from "@rubato/model-core"

import { AGENT_EFFORTS, type AgentEffort, type AgentError, type AgentRequest, type AgentResult, type EffortSource, type ModelCatalog, type PresetCatalog, type ResolvedAgentSpec } from "./types"
import { validateAgentRequest } from "./validate"

export type ResolveAgentRequestCatalogs = {
  readonly models: ModelCatalog
  readonly presets: PresetCatalog
}

export type ResolvedEffort = {
  readonly effort: AgentEffort
  readonly effortSource: EffortSource
}

export function resolveEffort(input: {
  readonly requestEffort?: AgentEffort
  readonly model: string
}): ResolvedEffort | undefined {
  const resolved = resolveModelEffort(input.model, input.requestEffort)
  if (resolved === undefined) return undefined
  const effort = asAgentEffort(resolved.effort)
  if (effort === undefined) return undefined
  return { effort, effortSource: resolved.effortSource }
}

export function resolveAgentRequest(
  request: AgentRequest,
  catalogs: ResolveAgentRequestCatalogs,
): AgentResult<ResolvedAgentSpec> {
  const validated = validateAgentRequest(request)
  if (!validated.ok) return validated

  const selected = validated.value
  if (selected.preset !== undefined) {
    const preset = catalogs.presets.get(selected.preset)
    if (preset === undefined) {
      return fail({
        code: "preset_unavailable",
        message: `preset '${selected.preset}' is not available.`,
        preset: selected.preset,
      })
    }
    return admit(selected, preset.model, selected.preset, preset.prompt, catalogs)
  }

  const model = selected.model
  if (model === undefined) {
    return fail({ code: "invalid_request", message: "Exactly one of model or preset is required." })
  }
  return admit(selected, model, undefined, undefined, catalogs)
}

function admit(
  request: AgentRequest,
  model: string,
  preset: string | undefined,
  instructions: string | undefined,
  catalogs: ResolveAgentRequestCatalogs,
): AgentResult<ResolvedAgentSpec> {
  // Exact-model admission is fail-closed here. A named preset still carries a model for effort
  // resolution, but the host re-resolves the persona's live chain, so missing catalog rows must
  // not block spawn of a loaded agent.
  if (preset === undefined && !catalogs.models.has(model)) {
    return fail({
      code: "model_unavailable",
      message: `model '${model}' is not available.`,
      model,
    })
  }
  const effort = resolveEffort({
    ...(request.effort === undefined ? {} : { requestEffort: request.effort }),
    model,
  })
  return {
    ok: true,
    value: {
      prompt: request.prompt,
      model,
      ...(effort === undefined ? {} : effort),
      ...(preset === undefined ? {} : { preset }),
      ...(request.summary === undefined ? {} : { summary: request.summary }),
      ...(instructions === undefined ? {} : { instructions }),
    },
  }
}

function asAgentEffort(value: string): AgentEffort | undefined {
  return AGENT_EFFORTS.find((effort) => effort === value)
}

function fail(error: AgentError): AgentResult<never> {
  return { ok: false, error }
}
