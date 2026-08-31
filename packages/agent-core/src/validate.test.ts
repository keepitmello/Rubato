import { describe, expect, test } from "bun:test"

import { validateAgentRequest } from "./validate"

describe("validateAgentRequest", () => {
  test("#given only a model #when validated #then the request is accepted", () => {
    const result = validateAgentRequest({ prompt: "Inspect the adapter", model: "xai/grok-4.6" })

    expect(result).toEqual({
      ok: true,
      value: { prompt: "Inspect the adapter", model: "xai/grok-4.6" },
    })
  })

  test("#given only a preset #when validated #then the request is accepted", () => {
    const result = validateAgentRequest({ prompt: "Review the plan", preset: "momus" })

    expect(result).toEqual({
      ok: true,
      value: { prompt: "Review the plan", preset: "momus" },
    })
  })

  test("#given both model and preset #when validated #then invalid_request is returned", () => {
    const result = validateAgentRequest({
      prompt: "Do both",
      model: "xai/grok-4.6",
      preset: "momus",
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected invalid_request")
    expect(result.error.code).toBe("invalid_request")
    expect(result.error.message).toContain("Exactly one")
  })

  test("#given neither model nor preset #when validated #then invalid_request is returned", () => {
    const result = validateAgentRequest({ prompt: "No target" })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected invalid_request")
    expect(result.error.code).toBe("invalid_request")
  })

  test("#given a blank prompt #when validated #then invalid_request is returned", () => {
    const result = validateAgentRequest({ prompt: "  ", model: "xai/grok-4.6" })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected invalid_request")
    expect(result.error.code).toBe("invalid_request")
    expect(result.error.message).toContain("prompt")
  })

  test("#given blank target padding #when validated #then empty model or preset is treated as omitted", () => {
    const bothBlank = validateAgentRequest({ prompt: "go", model: " ", preset: "" })
    const modelOnly = validateAgentRequest({ prompt: "go", model: "xai/grok-4.6", preset: "  " })

    expect(bothBlank.ok).toBe(false)
    expect(modelOnly).toEqual({
      ok: true,
      value: { prompt: "go", model: "xai/grok-4.6" },
    })
  })
})
