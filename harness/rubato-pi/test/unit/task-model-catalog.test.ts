import { describe, expect, test } from "bun:test"

import { createTaskChildPlanner } from "../../../../packages/rubato-runtime/src/components/task/planner"
import { supportedProviders } from "../../src/extensions/provider-overlay.mjs"

describe("picker and task model catalog parity", () => {
  // FX bridge 삭제 전에는 이 목록이 bridge catalog(`FALLBACK_CATALOG`)에서 합성됐다.
  // 이제 등록하는 것은 pinned native factory 뿐이므로 그 목록이 곧 picker 가 보는 것이다.
  // env 를 비워 넘긴다 — Cursor 는 native 직결뿐이라 network canary 를 돌리지 않는다.
  test("every model visible to the picker can override a task category", async () => {
    const providers = await supportedProviders({ env: {} })
    const models = providers.flatMap((provider) => provider.getModels())
    // 빈 목록은 통과가 아니다. 등록이 조용히 죽으면 아래 루프가 0번 돌고 초록이 된다.
    expect(models.length).toBeGreaterThan(0)
    const registry = {
      getAvailable: () => models,
      find: (provider: string, modelId: string) =>
        models.find((model) => model.provider === provider && model.id === modelId),
    }
    const planner = createTaskChildPlanner(
      { categories: { sol: { model: "openai-codex/gpt-5.6-sol" } } },
      {},
      () => registry,
    )

    for (const model of models) {
      const id = `${model.provider}/${model.id}`
      const result = planner({
        prompt: "Use the selected model.",
        parent_session_id: "parent-1",
        depth: 0,
        category: "sol",
        model: id,
      })
      expect(result.kind, id).toBe("resolved")
      if (result.kind !== "resolved") continue
      expect(result.plan.model).toBe(id)
      expect(result.plan.category).toBe("sol")
      expect(result.plan.resolved_model?.source).toBe("explicit")
    }
  })
})
