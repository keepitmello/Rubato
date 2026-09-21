import { describe, expect, test } from "bun:test"
import { AGENT_MODEL_REQUIREMENTS } from "./model-requirements"

describe("AGENT_MODEL_REQUIREMENTS", () => {
  test("oracle has gpt-5.6-sol xhigh as primary", () => {
    // given
    const oracle = AGENT_MODEL_REQUIREMENTS["oracle"]

    // when
    const primary = oracle.fallbackChain[0]

    // then
    expect(oracle.fallbackChain).toBeArray()
    expect(oracle.fallbackChain.length).toBeGreaterThan(0)
    expect(primary).toEqual({
      providers: ["openai", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "xhigh",
    })
    expect(oracle.fallbackChain[1]).toEqual({
      providers: ["github-copilot"],
      model: "gpt-5.6-sol",
      variant: "high",
    })
  })

  test("ultraworker keeps opus primary before Kimi K3, gpt-5.6-sol, GLM 5.2, and big-pickle fallbacks", () => {
    // given
    const ultraworker = AGENT_MODEL_REQUIREMENTS["ultraworker"]

    // when
    const [primary, second, solFallback, fourth, last] = ultraworker.fallbackChain

    // then
    expect(ultraworker.fallbackChain).toHaveLength(5)
    expect(ultraworker.requiresAnyModel).toBe(true)
    expect(primary).toEqual({
      providers: ["anthropic", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "max",
    })
    expect(second).toEqual({
      providers: [
        "opencode-go",
        "kimi-for-coding",
        "moonshotai",
        "opencode",
        "vercel",
        "bailian-coding-plan",
        "moonshotai-cn",
        "firmware",
        "ollama-cloud",
        "aihubmix",
      ],
      model: "kimi-k3",
    })
    expect(solFallback).toEqual({
      providers: ["openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "medium",
    })
    expect(fourth?.providers[0]).toBe("zai-coding-plan")
    expect(fourth?.model).toBe("glm-5.2")
    expect(last?.providers[0]).toBe("opencode")
    expect(last?.model).toBe("big-pickle")
  })

  test("multimodal-looker keeps vision-capable fallback order", () => {
    // given
    const multimodalLooker = AGENT_MODEL_REQUIREMENTS["multimodal-looker"]

    // when
    const [primary, secondary, tertiary, last] = multimodalLooker.fallbackChain

    // then
    expect(multimodalLooker.fallbackChain).toHaveLength(4)
    expect(primary).toEqual({
      providers: ["openai", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "low",
    })
    expect(secondary).toEqual({ providers: ["opencode-go", "vercel"], model: "kimi-k3" })
    expect(tertiary?.model).toBe("glm-4.6v")
    expect(last).toEqual({
      providers: ["openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5-nano",
    })
  })

  test("prometheus uses Fable 5.1 xhigh before Kimi K3 max", () => {
    // given
    const prometheus = AGENT_MODEL_REQUIREMENTS["prometheus"]

    // when
    const [primary, kimiFallback] = prometheus.fallbackChain

    // then
    expect(prometheus.fallbackChain).toHaveLength(2)
    expect(primary).toEqual({
      providers: ["anthropic", "github-copilot", "opencode", "vercel"],
      model: "claude-fable-5-1",
      variant: "xhigh",
    })
    expect(kimiFallback).toEqual({
      providers: ["opencode-go", "kimi-for-coding", "moonshotai", "opencode", "vercel"],
      model: "kimi-k3",
      variant: "max",
    })
  })

  test("atlas keeps sonnet, kimi, gpt-5.6-sol, and minimax fallback order", () => {
    // given
    const atlas = AGENT_MODEL_REQUIREMENTS["atlas"]

    // when
    const [primary, secondary, solFallback, fourth, fifth, sixth] = atlas.fallbackChain

    // then
    expect(atlas.fallbackChain).toHaveLength(6)
    expect(primary?.model).toBe("claude-sonnet-5")
    expect(primary?.providers[0]).toBe("anthropic")
    expect(secondary?.model).toBe("kimi-k3")
    expect(secondary?.providers[0]).toBe("opencode-go")
    expect(solFallback).toEqual({
      providers: ["openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "medium",
    })
    expect(fourth?.model).toBe("minimax-m3")
    expect(fourth?.providers[0]).toBe("opencode-go")
    expect(fifth).toEqual({
      providers: ["minimax-coding-plan", "minimax-cn-coding-plan"],
      model: "MiniMax-M3",
    })
    expect(sixth?.model).toBe("minimax-m2.7")
    expect(sixth?.providers[0]).toBe("opencode-go")
  })

  test("ultraworker-junior keeps sonnet, Kimi, minimax, and big-pickle fallbacks", () => {
    // given
    const ultraworkerJunior = AGENT_MODEL_REQUIREMENTS["ultraworker-junior"]

    // when
    const modelIDs = ultraworkerJunior.fallbackChain.map((entry) => entry.model)

    // then
    expect(modelIDs).toEqual([
      "claude-sonnet-5",
      "kimi-k3",
      "gpt-5.6-sol",
      "minimax-m3",
      "MiniMax-M3",
      "minimax-m2.7",
      "big-pickle",
    ])
    expect(modelIDs).not.toContain("gpt-5.5")
  })

  test("hephaestus supports openai, github-copilot, opencode, and vercel providers", () => {
    // given
    const hephaestus = AGENT_MODEL_REQUIREMENTS["hephaestus"]

    // when / then
    expect(hephaestus.requiresProvider).toEqual([
      "openai",
      "github-copilot",
      "opencode",
      "vercel",
    ])
    expect(hephaestus.requiresProvider).not.toContain("venice")
    expect(hephaestus.fallbackChain[0]?.providers).not.toContain("venice")
    expect(hephaestus.requiresModel).toBeUndefined()
    expect(hephaestus.requiresAnyModel).toBe(true)
  })

  test("hephaestus has one merged gpt-5.6-sol medium rung", () => {
    // given
    const hephaestus = AGENT_MODEL_REQUIREMENTS["hephaestus"]

    // when
    const [primary] = hephaestus.fallbackChain

    // then
    expect(hephaestus.fallbackChain).toHaveLength(1)
    expect(primary).toEqual({
      providers: ["openai", "github-copilot", "vercel", "opencode"],
      model: "gpt-5.6-sol",
      variant: "medium",
    })
  })
})
