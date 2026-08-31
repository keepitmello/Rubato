export type TaskTargetErrorCode = "both_targets" | "no_target"

export type TaskTargetError = {
  readonly code: TaskTargetErrorCode
  readonly message: string
}

export type TaskTargetSelection =
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "category"; readonly category: string }
  | { readonly kind: "subagent_type"; readonly subagentType: string }
  | { readonly kind: "error"; readonly error: TaskTargetError }

type TargetInput = {
  readonly category?: string
  readonly subagent_type?: string
  readonly model?: string
}

const BOTH_TARGETS_MESSAGE = "Provide EITHER category OR subagent_type, not both. Remove one and retry."

const NO_TARGET_MESSAGE =
  'Provide a model, category, or subagent_type. Example: task(model="kiro/claude-opus-5", prompt="...").'

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

export function validateTaskTarget(params: TargetInput): TaskTargetSelection {
  const hasCategory = present(params.category)
  const hasSubagent = present(params.subagent_type)
  if (hasCategory && hasSubagent) {
    return { kind: "error", error: { code: "both_targets", message: BOTH_TARGETS_MESSAGE } }
  }
  if (present(params.category)) {
    return { kind: "category", category: params.category.trim() }
  }
  if (present(params.subagent_type)) {
    return { kind: "subagent_type", subagentType: params.subagent_type.trim() }
  }
  if (present(params.model)) {
    return { kind: "model", model: params.model.trim() }
  }
  return { kind: "error", error: { code: "no_target", message: NO_TARGET_MESSAGE } }
}
