import { describe, expect, test } from "bun:test"

import {
  MANUAL_OVERRIDE_EFFORT_SOURCE,
  MODEL_DEFAULT_EFFORT_SOURCE,
  configuredModelEffort,
  resolveModelEffort,
} from "./model-effort-defaults"

describe("configuredModelEffort", () => {
  test.each([
    ["openai-codex/gpt-5.6-sol", "medium"],
    ["openai-codex/gpt-5.6-sol-fast", "medium"],
    ["kiro/gpt-5.6-sol", "medium"],
    ["anthropic/claude-opus-5", "high"],
    ["anthropic/claude-fable-5-1", "high"],
    ["xai/grok-4.6", "high"],
    ["cursor/cursor-grok-4.6-high-fast", "high"],
    ["google-antigravity/gemini-3.7-flash", "medium"],
  ] as const)("#given %s #then the seeded default is %s", (model, effort) => {
    expect(configuredModelEffort(model)).toBe(effort)
  })

  test("#given models outside the seeded families #then no default is invented", () => {
    expect(configuredModelEffort("openai-codex/gpt-5.6-luna-fast")).toBeUndefined()
    expect(configuredModelEffort("google/gemini-3.1-pro")).toBeUndefined()
    expect(configuredModelEffort("cursor/gemini-3.7-flash")).toBeUndefined()
    expect(configuredModelEffort("openai/gpt-5.5")).toBeUndefined()
  })
})

describe("resolveModelEffort", () => {
  test("#given an omitted override #then the source is model-default", () => {
    expect(resolveModelEffort("openai-codex/gpt-5.6-sol")).toEqual({
      effort: "medium",
      effortSource: MODEL_DEFAULT_EFFORT_SOURCE,
    })
  })

  test("#given an explicit override #then it wins over the seeded default", () => {
    expect(resolveModelEffort("openai-codex/gpt-5.6-sol", "xhigh")).toEqual({
      effort: "xhigh",
      effortSource: MANUAL_OVERRIDE_EFFORT_SOURCE,
    })
  })

  test("#given an empty override #then the model default still applies", () => {
    expect(resolveModelEffort("anthropic/claude-opus-5", "")).toEqual({
      effort: "high",
      effortSource: MODEL_DEFAULT_EFFORT_SOURCE,
    })
  })
})
