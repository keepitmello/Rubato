export type DelegateTaskErrorPattern = {
  readonly pattern: string
  readonly errorType: string
  readonly fixHint: string
}

export const DELEGATE_TASK_ERROR_PATTERNS: readonly DelegateTaskErrorPattern[] = [
  {
    pattern: "exactly one of model or preset",
    errorType: "mutual_exclusion",
    fixHint: "Provide exactly one target: an exact provider/model id or a loaded preset name",
  },
  {
    pattern: "requires a model or preset",
    errorType: "missing_target",
    fixHint: "Add either model='provider/model' or preset='explore'",
  },
  {
    pattern: "model_unavailable",
    errorType: "model_unavailable",
    fixHint: "Use an exact model id admitted by the live model catalog",
  },
  {
    pattern: "Skills not found",
    errorType: "unknown_skills",
    fixHint: "Use valid skill names from the Available list in the error message",
  },
] as const

export type DetectedError = {
  readonly errorType: string
  readonly originalOutput: string
}

export function detectDelegateTaskError(output: string): DetectedError | null {
  if (!output.includes("[ERROR]") && !output.includes("Invalid arguments")) return null

  for (const errorPattern of DELEGATE_TASK_ERROR_PATTERNS) {
    if (output.includes(errorPattern.pattern)) {
      return {
        errorType: errorPattern.errorType,
        originalOutput: output,
      }
    }
  }

  return null
}
