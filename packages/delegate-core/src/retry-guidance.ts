import { DELEGATE_TASK_ERROR_PATTERNS, type DetectedError } from "./retry-patterns"

function extractAvailableList(output: string): string | null {
  const availableMatch = output.match(/Available[^:]*:\s*(.+)$/m)
  return availableMatch ? availableMatch[1].trim() : null
}

export function buildRetryGuidance(errorInfo: DetectedError): string {
  const pattern = DELEGATE_TASK_ERROR_PATTERNS.find(
    (entry) => entry.errorType === errorInfo.errorType
  )

  if (!pattern) {
    return `[task ERROR] Fix the error and retry with correct parameters.`
  }

  let guidance = `
 [Agent CALL FAILED - IMMEDIATE RETRY REQUIRED]

 **Error Type**: ${errorInfo.errorType}
 **Fix**: ${pattern.fixHint}
 `

  const availableList = extractAvailableList(errorInfo.originalOutput)
  if (availableList) {
    guidance += `\n**Available Options**: ${availableList}\n`
  }

  guidance += `
 **Action**: Retry Agent NOW with corrected parameters.

 Example of CORRECT call:
 \`\`\`
 Agent(
   model="provider/model",
   prompt="Detailed prompt...",
   summary="One-line delegated outcome"
 )
 \`\`\`
 `

  return guidance
}
