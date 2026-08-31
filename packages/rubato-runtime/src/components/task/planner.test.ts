import { describe, expect, test } from "bun:test"

import { BUILTIN_AGENTS, type SenpiModelPort } from "@rubato/senpi-task"

import { createTaskChildPlanner, plannedEffortSource, type TaskModelRegistry } from "./planner"

type FakeModel = SenpiModelPort & { readonly name?: string }

function model(provider: string, id: string, name?: string): FakeModel {
  return { provider, id, ...(name === undefined ? {} : { name }) }
}

function registry(models: readonly FakeModel[]): TaskModelRegistry {
  return {
    getAvailable: () => models,
    find: (provider, modelId) =>
      models.find((candidate) => candidate.provider === provider && candidate.id === modelId),
  }
}

function expectResolved(plan: ReturnType<ReturnType<typeof createTaskChildPlanner>>): Extract<typeof plan, { readonly kind: "resolved" }> {
  if (plan.kind !== "resolved") {
    throw new Error(`Expected resolved plan, got ${plan.kind}`)
  }
  return plan
}

describe("createTaskChildPlanner", () => {
  test("#given a category with model metadata #when planned #then resolved_model preserves display, variant, and reasoning effort", () => {
    // given
    const planner = createTaskChildPlanner(
      {
        categories: {
          ultrabrain: {
            model: "google/gemini-3.1-pro",
            variant: "high",
            reasoningEffort: "xhigh",
          },
        },
      },
      {},
      () => registry([model("google", "gemini-3.1-pro", "Gemini 3.1 Pro")]),
    )

    // when
    const result = planner({
      prompt: "Find the hard bug.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "ultrabrain",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.model).toBe("google/gemini-3.1-pro")
    expect(resolved.plan.resolved_model).toEqual({
      source: "category",
      provider: "google",
      model_id: "gemini-3.1-pro",
      display: "Gemini 3.1 Pro",
      variant: "high",
      reasoning_effort: "xhigh",
    })
  })

  test("#given visual-engineering falls back to a variant-bearing model #when planned #then resolved_model keeps fallback variant metadata", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      {},
      () => registry([model("zai-coding-plan", "glm-5.2")]),
    )

    // when
    const result = planner({
      prompt: "Think hard.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "visual-engineering",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.resolved_model).toMatchObject({
      source: "category",
      provider: "zai-coding-plan",
      model_id: "glm-5.2",
      display: "zai-coding-plan/glm-5.2",
      variant: "max",
    })
  })

  test("#given an explicit provider model #when planned #then explicit metadata does not invent variant or reasoning effort", () => {
    // given
    const planner = createTaskChildPlanner(
      {
        categories: {
          ultrabrain: {
            model: "google/gemini-3.1-pro",
            variant: "high",
            reasoningEffort: "xhigh",
          },
        },
      },
      {},
      () => registry([model("google", "gemini-3.1-pro"), model("openai", "gpt-5.5")]),
    )

    // when
    const result = planner({
      prompt: "Use this model directly.",
      parent_session_id: "parent-1",
      depth: 0,
      model: "openai/gpt-5.5",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan).toEqual({
      model: "openai/gpt-5.5",
      resolved_model: {
        source: "explicit",
        provider: "openai",
        model_id: "gpt-5.5",
        display: "openai/gpt-5.5",
      },
    })
  })

  test("#given a category and picker-visible model override #when planned #then category persona uses that exact model", () => {
    const planner = createTaskChildPlanner(
      { categories: { sol: { model: "openai-codex/gpt-5.6-sol", prompt_append: "Act as a coding owner." } } },
      {},
      () => registry([
        model("openai-codex", "gpt-5.6-sol"),
        model("openai-codex", "gpt-daybreak-blue-latest-fast", "Daybreak Blue Fast"),
      ]),
    )

    const result = planner({
      prompt: "Ship the fix.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "sol",
      model: "openai-codex/gpt-daybreak-blue-latest-fast",
    })

    const resolved = expectResolved(result)
    expect(resolved.plan).toMatchObject({
      model: "openai-codex/gpt-daybreak-blue-latest-fast",
      category: "sol",
      promptAppend: "Act as a coding owner.",
      resolved_model: {
        source: "explicit",
        provider: "openai-codex",
        model_id: "gpt-daybreak-blue-latest-fast",
      },
      requested_model: {
        source: "explicit",
        provider: "openai-codex",
        model_id: "gpt-daybreak-blue-latest-fast",
      },
    })
  })

  test("#given category reasoning with an explicit model #when planned #then category effort does not override the model default", () => {
    const planner = createTaskChildPlanner(
      { categories: { sol: { model: "openai-codex/gpt-5.6-sol", reasoning: "xhigh" } } },
      {},
      () => registry([
        model("openai-codex", "gpt-5.6-sol"),
        model("openai-codex", "gpt-daybreak-blue-latest-fast"),
      ]),
    )

    const result = planner({
      prompt: "Ship the fix.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "sol",
      model: "openai-codex/gpt-5.6-sol",
    })

    const resolved = expectResolved(result)
    expect(resolved.plan.variant).toBe("medium")
    expect(resolved.plan.resolved_model).toMatchObject({ source: "explicit", reasoning: "medium" })
    expect(plannedEffortSource(resolved.plan.resolved_model)).toBe("model-default")
  })

  test("#given a category and model absent from the picker registry #when planned #then it is rejected", () => {
    const available = [model("openai-codex", "gpt-5.6-sol")]
    const hidden = model("openai-codex", "not-in-picker")
    const planner = createTaskChildPlanner(
      { categories: { sol: { model: "openai-codex/gpt-5.6-sol" } } },
      {},
      () => ({
        getAvailable: () => available,
        find: (provider: string, modelId: string) =>
          [...available, hidden].find((entry) => entry.provider === provider && entry.id === modelId),
      }),
    )

    const result = planner({
      prompt: "Ship the fix.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "sol",
      model: "openai-codex/not-in-picker",
    })

    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("expected error")
    expect(result.error.code).toBe("model_unavailable")
  })

  test("#given an explicit category model on a builtin chain #when planned #then no fallback vendor survives", () => {
    const planner = createTaskChildPlanner(
      {},
      {},
      () => registry([
        model("anthropic", "claude-opus-5"),
        model("kimi-coding", "k3"),
        model("zai-coding-plan", "glm-5.2"),
        model("openai", "gpt-5.6-sol"),
      ]),
    )

    const result = planner({
      prompt: "Design the UI.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "visual-engineering",
      model: "anthropic/claude-opus-5",
    })

    const resolved = expectResolved(result)
    expect(resolved.plan.model).toBe("anthropic/claude-opus-5")
    expect(resolved.plan.fallback_models).toBeUndefined()
  })

  test("#given a gated builtin category #when model override is available but its gate is not #then the gate remains closed", () => {
    const planner = createTaskChildPlanner(
      {},
      {},
      () => registry([model("openai-codex", "gpt-5.6-sol")]),
    )

    const result = planner({
      prompt: "Architect this.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "architect",
      model: "openai-codex/gpt-5.6-sol",
    })

    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("expected error")
    expect(result.error.code).toBe("model_unavailable")
  })

  test("#given an unknown category and picker-visible model #when planned #then the model cannot invent a persona", () => {
    const planner = createTaskChildPlanner(
      { categories: { sol: { model: "openai-codex/gpt-5.6-sol" } } },
      {},
      () => registry([model("openai-codex", "gpt-daybreak-blue-latest-fast")]),
    )

    const result = planner({
      prompt: "Ship the fix.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "invented",
      model: "openai-codex/gpt-daybreak-blue-latest-fast",
    })

    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("expected error")
    expect(result.error.code).toBe("unknown_target")
  })

  test("#given subagent_type naming a builtin agent #when planned against a registry serving its chain #then the plan carries the agent persona and an agent-sourced model", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      BUILTIN_AGENTS,
      () => registry([model("openai", "gpt-5.6-luna-fast")]),
    )

    // when
    const result = planner({
      prompt: "Find the auth flow.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "explore",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.model).toBe("openai/gpt-5.6-luna-fast")
    expect(resolved.plan.resolved_model).toEqual({
      source: "agent",
      provider: "openai",
      model_id: "gpt-5.6-luna-fast",
      display: "openai/gpt-5.6-luna-fast",
      variant: "low",
      reasoning: "low",
    })
    expect(resolved.plan.agentType).toBe("explore")
    expect(resolved.plan.instructions).toBe(BUILTIN_AGENTS.explore?.prompt)
    expect(resolved.plan.toolAllowlist).toEqual([
      "read",
      "find",
      "grep",
      "ls",
      "bash",
      "lsp_diagnostics",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_symbols",
    ])
    expect(resolved.plan.agentExecutionMode).toBe("in-process")
  })

  test("#given an explicit model with subagent_type #when planned against a live registry #then the agent persona is kept and the model stays explicit", () => {
    // given
    const planner = createTaskChildPlanner({}, BUILTIN_AGENTS, () => registry([model("openai", "gpt-5.5")]))

    // when
    const result = planner({
      prompt: "Review this design.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "momus",
      model: "openai/gpt-5.5",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.model).toBe("openai/gpt-5.5")
    expect(resolved.plan.resolved_model).toEqual({
      source: "explicit",
      provider: "openai",
      model_id: "gpt-5.5",
      display: "openai/gpt-5.5",
    })
    expect(resolved.plan.agentType).toBe("momus")
    expect(resolved.plan.instructions).toBeDefined()
    expect(resolved.plan.toolAllowlist).toHaveLength(9)
    expect(resolved.plan.agentExecutionMode).toBe("in-process")
  })

  test("#given an explicit model and caller reasoning #when planned #then the child and status metadata use that manual override", () => {
    const planner = createTaskChildPlanner(
      {},
      {},
      () => registry([model("openai-codex", "gpt-5.6-sol-fast")]),
    )

    const result = planner({
      prompt: "work",
      model: "openai-codex/gpt-5.6-sol-fast",
      reasoning: "xhigh",
      parent_session_id: "parent",
      depth: 1,
    })

    const resolved = expectResolved(result)
    expect(resolved.plan).toMatchObject({
      model: "openai-codex/gpt-5.6-sol-fast",
      variant: "xhigh",
      resolved_model: {
        reasoning: "xhigh",
        reasoning_effort: "xhigh",
      },
    })
    expect(plannedEffortSource(resolved.plan.resolved_model)).toBe("manual-override")
  })

  test.each([
    ["openai-codex/gpt-5.6-sol", "medium"],
    ["openai-codex/gpt-5.6-sol-fast", "medium"],
    ["anthropic/claude-opus-5", "high"],
    ["anthropic/claude-fable-5", "high"],
    ["xai/grok-4.6", "high"],
    ["cursor/cursor-grok-4.6-high-fast", "high"],
    ["google-antigravity/gemini-3.7-flash", "medium"],
  ])("#given direct model %s without caller reasoning #then it uses model default %s", (modelId, reasoning) => {
    const slash = modelId.indexOf("/")
    const planner = createTaskChildPlanner(
      {},
      {},
      () => registry([model(modelId.slice(0, slash), modelId.slice(slash + 1))]),
    )

    const resolved = expectResolved(planner({
      prompt: "work",
      model: modelId,
      parent_session_id: "parent",
      depth: 1,
    }))

    expect(resolved.plan.variant).toBe(reasoning)
    expect(resolved.plan.resolved_model?.reasoning).toBe(reasoning)
    expect(plannedEffortSource(resolved.plan.resolved_model)).toBe("model-default")
  })

  test("#given an exact model absent from the live registry #when planned #then it fails closed with model_unavailable", () => {
    const planner = createTaskChildPlanner({}, {}, () => registry([model("openai-codex", "gpt-5.6-sol")]))

    const result = planner({
      prompt: "work",
      model: "google-antigravity/gemini-3.7-flash",
      parent_session_id: "parent",
      depth: 1,
    })

    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("expected error")
    expect(result.error.code).toBe("model_unavailable")
  })

  test("#given an exact model and no registry #when planned #then it fails closed", () => {
    const planner = createTaskChildPlanner({}, {}, () => undefined)

    const result = planner({
      prompt: "work",
      model: "openai-codex/gpt-5.6-sol",
      parent_session_id: "parent",
      depth: 1,
    })

    expect(result).toEqual({
      kind: "error",
      error: {
        code: "model_unavailable",
        message: "No senpi model registry is available yet to resolve a task model.",
      },
    })
  })

  test("#given a malformed model identifier #when planned #then it is invalid_target", () => {
    const planner = createTaskChildPlanner({}, {}, () => registry([]))

    const result = planner({
      prompt: "work",
      model: "gpt-5.6-sol",
      parent_session_id: "parent",
      depth: 1,
    })

    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("expected error")
    expect(result.error.code).toBe("invalid_target")
  })

  test("#given subagent_type naming a builtin agent with no registry #when planned #then it fails closed with the registry-unavailable error", () => {
    // given
    const planner = createTaskChildPlanner({}, BUILTIN_AGENTS, () => undefined)

    // when
    const result = planner({
      prompt: "Find the auth flow.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "explore",
    })

    // then
    expect(result).toEqual({
      kind: "error",
      error: {
        code: "model_unavailable",
        message: "No senpi model registry is available yet to resolve a task model.",
      },
    })
  })

  test("#given subagent_type naming a category rather than an agent #when planned #then category resolution still applies", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      BUILTIN_AGENTS,
      () => registry([model("zai-coding-plan", "glm-5.2")]),
    )

    // when
    const result = planner({
      prompt: "Think hard.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "visual-engineering",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.resolved_model).toMatchObject({ source: "category", provider: "zai-coding-plan" })
    expect(resolved.plan.category).toBe("visual-engineering")
  })

  test("#given a disabled agent sharing a category name #when planned without an explicit model #then category fallback remains available", () => {
    // given
    const agents = { ...BUILTIN_AGENTS, explore: { name: "explore", disable: true } }
    const planner = createTaskChildPlanner(
      { categories: { explore: { model: "google/gemini-3.1-pro" } } },
      agents,
      () => registry([model("google", "gemini-3.1-pro")]),
    )

    // when
    const result = planner({
      prompt: "Find the auth flow.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "explore",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.agentType).toBeUndefined()
    expect(resolved.plan.category).toBe("explore")
    expect(resolved.plan.resolved_model?.source).toBe("category")
  })

  test("#given a disabled agent and explicit model #when planned via subagent_type #then the model cannot bypass disablement", () => {
    // given
    const agents = { ...BUILTIN_AGENTS, momus: { name: "momus", disable: true } }
    const planner = createTaskChildPlanner({}, agents, () => undefined)

    // when
    const result = planner({
      prompt: "Review this design.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "momus",
      model: "openai/gpt-5.5",
    })

    // then
    if (result.kind !== "error") throw new Error(`Expected error resolution, got ${result.kind}`)
    expect(result.error.code).toBe("unknown_target")
    expect(result.error.availableAgents).toEqual(["explore", "librarian", "metis"])
  })

  test("#given an unknown subagent_type #when planned #then the unknown-target error lists available agents and categories", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      BUILTIN_AGENTS,
      () => registry([model("google", "gemini-3.1-pro")]),
    )

    // when
    const result = planner({
      prompt: "Do something.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "nonexistent",
    })

    // then
    if (result.kind !== "error") throw new Error(`Expected error resolution, got ${result.kind}`)
    expect(result.error.code).toBe("unknown_target")
    expect(result.error.availableAgents).toEqual(["explore", "librarian", "metis", "momus"])
    // writing survives on a gemini-only registry (its gemini-3.1-pro rung resolves); ultrabrain's
    // sol-only chain is dead, so the dead-chain gate excludes it.
    expect(result.error.availableCategories).toContain("writing")
    expect(result.error.availableCategories).not.toContain("ultrabrain")
  })

  test("#given subagent_type naming a builtin agent whose chain no registry model satisfies #when planned #then it reports model_unavailable with the agent list", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      BUILTIN_AGENTS,
      () => registry([model("acme", "unrelated-1")]),
    )

    // when
    const result = planner({
      prompt: "Find the auth flow.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "explore",
    })

    // then
    if (result.kind !== "error") throw new Error(`Expected error resolution, got ${result.kind}`)
    expect(result.error.code).toBe("model_unavailable")
    expect(result.error.message).toContain('No available model for agent "explore"')
    expect(result.error.availableAgents).toEqual(["explore", "librarian", "metis", "momus"])
  })
})

describe("createTaskChildPlanner plan variant", () => {
  test("#given a category with an explicit reasoning effort and a variant #when planned #then category effort is not applied", () => {
    // given
    const planner = createTaskChildPlanner(
      {
        categories: {
          ultrabrain: {
            model: "google/gemini-3.1-pro",
            variant: "high",
            reasoningEffort: "xhigh",
          },
        },
      },
      {},
      () => registry([model("google", "gemini-3.1-pro")]),
    )

    // when
    const result = planner({
      prompt: "Find the hard bug.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "ultrabrain",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.variant).toBeUndefined()
    expect(plannedEffortSource(resolved.plan.resolved_model)).toBeUndefined()
  })

  test("#given a seeded Opus category with a different configured effort #when planned #then the model default wins", () => {
    const planner = createTaskChildPlanner(
      {
        categories: {
          ultrabrain: {
            model: "anthropic/claude-opus-5",
            reasoningEffort: "xhigh",
          },
        },
      },
      {},
      () => registry([model("anthropic", "claude-opus-5")]),
    )

    const resolved = expectResolved(planner({
      prompt: "Find the hard bug.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "ultrabrain",
    }))

    expect(resolved.plan.variant).toBe("high")
    expect(resolved.plan.resolved_model?.reasoning).toBe("high")
    expect(plannedEffortSource(resolved.plan.resolved_model)).toBe("model-default")
  })

  test("#given a category with variant only #when planned #then that variant is not applied as effort", () => {
    // given
    const planner = createTaskChildPlanner(
      {
        categories: {
          ultrabrain: {
            model: "google/gemini-3.1-pro",
            variant: "high",
          },
        },
      },
      {},
      () => registry([model("google", "gemini-3.1-pro")]),
    )

    // when
    const result = planner({
      prompt: "Find the hard bug.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "ultrabrain",
    })

    // then
    expect(expectResolved(result).plan.variant).toBeUndefined()
  })

  test("#given a category resolving a variant-bearing fallback without a model default #when planned #then no effort is invented", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      {},
      () => registry([model("zai-coding-plan", "glm-5.2")]),
    )

    // when
    const result = planner({
      prompt: "Think hard.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "visual-engineering",
    })

    // then
    expect(expectResolved(result).plan.variant).toBeUndefined()
  })

  test("#given an explicit provider model #when planned #then no variant is applied", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      {},
      () => registry([model("openai", "gpt-5.5")]),
    )

    // when
    const result = planner({
      prompt: "Use this model directly.",
      parent_session_id: "parent-1",
      depth: 0,
      model: "openai/gpt-5.5",
    })

    // then
    expect(expectResolved(result).plan.variant).toBeUndefined()
    expect(plannedEffortSource(expectResolved(result).plan.resolved_model)).toBeUndefined()
  })

  test("#given momus resolves Sol #when planned #then the applied effort is the Sol model default", () => {
    // given
    const planner = createTaskChildPlanner(
      {},
      BUILTIN_AGENTS,
      () => registry([model("openai", "gpt-5.6-sol")]),
    )

    // when
    const result = planner({
      prompt: "Review the plan.",
      parent_session_id: "parent-1",
      depth: 0,
      subagent_type: "momus",
    })

    // then
    const resolved = expectResolved(result)
    expect(resolved.plan.model).toBe("openai/gpt-5.6-sol")
    expect(resolved.plan.variant).toBe("medium")
    expect(plannedEffortSource(resolved.plan.resolved_model)).toBe("model-default")
  })
})
