import { describe, expect, test } from "bun:test"

import {
  MANUAL_OVERRIDE_EFFORT_SOURCE,
  MODEL_DEFAULT_EFFORT_SOURCE,
  configuredModelEffort,
  resolveModelEffort,
} from "./model-effort-defaults"
import { PRODUCT_MODEL_ORDER } from "./product-model-catalog"

// Antigravity Flash 는 정확한 id 로 판정된다 — 현재 세대 id 는 카탈로그가 소유하므로
// 여기서 손으로 적으면 세대가 바뀔 때마다 이 케이스가 먼저 깨진다.
const ANTIGRAVITY_FLASH = PRODUCT_MODEL_ORDER["google-antigravity"][0]

describe("configuredModelEffort", () => {
  test.each([
    ["openai-codex/gpt-5.6-sol", "medium"],
    ["openai-codex/gpt-5.6-sol-fast", "medium"],
    ["kiro/gpt-5.6-sol", "medium"],
    ["anthropic/claude-opus-5", "high"],
    ["anthropic/claude-fable-5-1", "high"],
    ["xai/grok-4.7", "high"],
    ["cursor/grok-4.7-high-fast", "high"],
    [`google-antigravity/${ANTIGRAVITY_FLASH}`, "medium"],
  ] as const)("#given %s #then the seeded default is %s", (model, effort) => {
    expect(configuredModelEffort(model)).toBe(effort)
  })

  test("#given models outside the seeded families #then no default is invented", () => {
    expect(configuredModelEffort("openai-codex/gpt-5.6-luna-fast")).toBeUndefined()
    expect(configuredModelEffort("google/gemini-3.1-pro")).toBeUndefined()
    expect(configuredModelEffort("cursor/gemini-3.8-flash")).toBeUndefined()
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
