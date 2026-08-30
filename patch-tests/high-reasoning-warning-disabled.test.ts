import { describe, expect, test } from "bun:test"
import { shouldWarnHighReasoning } from "../node_modules/@code-yeongyu/senpi/dist/core/high-reasoning-warning.js"

describe("high-reasoning selection warning", () => {
  test("stays silent for xhigh and max", () => {
    const model = { id: "gpt-5.6-sol", provider: "openai-codex" }

    expect(shouldWarnHighReasoning(model, "xhigh")).toBe(false)
    expect(shouldWarnHighReasoning(model, "max")).toBe(false)
  })
})
