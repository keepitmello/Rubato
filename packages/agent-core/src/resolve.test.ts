import { describe, expect, test } from "bun:test"

import { resolveAgentRequest, resolveEffort } from "./resolve"
import type { ModelCatalog, PresetCatalog } from "./types"

const models: ModelCatalog = {
  has: (model) =>
    new Set([
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5",
      "xai/grok-4.6",
      "anthropic/claude-fable-5",
      "google-antigravity/gemini-3.7-flash",
      "openai-codex/gpt-5.6-luna-fast",
    ]).has(model),
}

const presets: PresetCatalog = {
  get: (name) => (name === "reviewer" ? { name: "reviewer", model: "anthropic/claude-opus-5", prompt: "Review." } : undefined),
}

const catalogs = { models, presets }

describe("resolveEffort", () => {
  test("#given seeded families #when read #then Sol is medium and Opus Grok Fable are high", () => {
    expect(resolveEffort({ model: "openai/gpt-5.6-sol" })).toEqual({
      effort: "medium",
      effortSource: "model-default",
    })
    expect(resolveEffort({ model: "anthropic/claude-opus-5" })).toEqual({
      effort: "high",
      effortSource: "model-default",
    })
    expect(resolveEffort({ model: "xai/grok-4.6" })).toEqual({
      effort: "high",
      effortSource: "model-default",
    })
    expect(resolveEffort({ model: "anthropic/claude-fable-5" })).toEqual({
      effort: "high",
      effortSource: "model-default",
    })
  })

  test("#given Antigravity Flash #when read #then the seeded default is medium", () => {
    expect(resolveEffort({ model: "google-antigravity/gemini-3.7-flash" })).toEqual({
      effort: "medium",
      effortSource: "model-default",
    })
  })

  test("#given an unlisted model #when read #then no default is invented", () => {
    expect(resolveEffort({ model: "openai-codex/gpt-5.6-luna-fast" })).toBeUndefined()
  })

  test("#given an explicit effort #when resolved #then it is a manual override", () => {
    expect(resolveEffort({ model: "openai/gpt-5.6-sol", requestEffort: "low" })).toEqual({
      effort: "low",
      effortSource: "manual-override",
    })
  })
})

describe("resolveAgentRequest", () => {
  test("#given an exact model #when resolved #then the spec records model-default effort", () => {
    const result = resolveAgentRequest({ prompt: "Inspect", model: "xai/grok-4.6" }, catalogs)

    expect(result).toEqual({
      ok: true,
      value: {
        prompt: "Inspect",
        model: "xai/grok-4.6",
        effort: "high",
        effortSource: "model-default",
      },
    })
  })

  test("#given a preset #when resolved #then its model and instructions are used and effort stays model-owned", () => {
    const result = resolveAgentRequest({ prompt: "Review this", preset: "reviewer", effort: "minimal" }, catalogs)

    expect(result).toEqual({
      ok: true,
      value: {
        prompt: "Review this",
        model: "anthropic/claude-opus-5",
        effort: "minimal",
        effortSource: "manual-override",
        preset: "reviewer",
        instructions: "Review.",
      },
    })
  })

  test("#given a preset #when the live catalog does not list models #then exact-model admission does not block the preset", () => {
    const result = resolveAgentRequest(
      { prompt: "Review this", preset: "reviewer" },
      { models: { has: () => false }, presets },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected preset to resolve")
    expect(result.value.preset).toBe("reviewer")
    expect(result.value.model).toBe("anthropic/claude-opus-5")
  })

  test("#given a missing model #when resolved #then model_unavailable is returned without a fallback", () => {
    const result = resolveAgentRequest({ prompt: "Inspect", model: "missing/model" }, catalogs)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected model_unavailable")
    expect(result.error).toEqual({
      code: "model_unavailable",
      message: "model 'missing/model' is not available.",
      model: "missing/model",
    })
  })

  test("#given a missing preset #when resolved #then preset_unavailable is returned", () => {
    const result = resolveAgentRequest({ prompt: "Inspect", preset: "ghost" }, catalogs)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected preset_unavailable")
    expect(result.error.code).toBe("preset_unavailable")
  })

  test("#given both targets #when resolved #then validation fails before admission", () => {
    const result = resolveAgentRequest(
      { prompt: "Inspect", model: "xai/grok-4.6", preset: "reviewer" },
      catalogs,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected invalid_request")
    expect(result.error.code).toBe("invalid_request")
  })

  test("#given a loaded preset whose model is not in the live catalog #when resolved #then the preset is admitted for host persona resolution", () => {
    const result = resolveAgentRequest({ prompt: "Review this", preset: "reviewer" }, {
      models: { has: () => false },
      presets,
    })

    expect(result).toEqual({
      ok: true,
      value: {
        prompt: "Review this",
        model: "anthropic/claude-opus-5",
        effort: "high",
        effortSource: "model-default",
        preset: "reviewer",
        instructions: "Review.",
      },
    })
  })
})
