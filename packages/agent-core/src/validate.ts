import { AGENT_EFFORTS, type AgentError, type AgentRequest, type AgentResult } from "./types"

const TARGET_RULE = "Exactly one of model or preset is required."

export function validateAgentRequest(request: AgentRequest): AgentResult<AgentRequest> {
  const prompt = request.prompt.trim()
  if (prompt.length === 0) {
    return fail("invalid_request", "prompt is required.")
  }

  const model = normalizeOptional(request.model)
  const preset = normalizeOptional(request.preset)
  if ((model === undefined) === (preset === undefined)) {
    return fail("invalid_request", TARGET_RULE)
  }

  if (request.effort !== undefined && !AGENT_EFFORTS.includes(request.effort)) {
    return fail("invalid_request", `effort must be one of ${AGENT_EFFORTS.join(", ")}.`)
  }

  return {
    ok: true,
    value: {
      prompt,
      ...(model === undefined ? {} : { model }),
      ...(preset === undefined ? {} : { preset }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.summary === undefined ? {} : { summary: request.summary }),
    },
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function fail(code: "invalid_request", message: string): AgentResult<never> {
  const error: AgentError = { code, message }
  return { ok: false, error }
}
