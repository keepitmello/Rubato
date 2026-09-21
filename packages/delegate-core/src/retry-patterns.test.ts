import { describe, expect, test } from "bun:test"
import { buildRetryGuidance, detectDelegateTaskError } from "./index"

describe("delegate task retry contract", () => {
  test("#given an unavailable model #when detected #then retry guidance preserves available options", () => {
    const output = '[ERROR] model_unavailable. Available models: openai/gpt-5.6-sol, xai/grok-4.7'
    const error = detectDelegateTaskError(output)

    expect(error).toEqual({
      errorType: "model_unavailable",
      originalOutput: output,
    })
    const guidance = error ? buildRetryGuidance(error) : ""
    const availableOptions = output.match(/Available[^:]*: (.+)$/)?.[1]?.split(", ")

    expect(guidance.length).toBeGreaterThan(0)
    expect(availableOptions).toBeDefined()
    expect(availableOptions?.every((option) => guidance.includes(option))).toBe(true)
  })
})
