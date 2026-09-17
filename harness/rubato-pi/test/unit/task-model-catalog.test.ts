import { describe, expect, test } from "bun:test"

import { catalogSlugs } from "../../../../packages/model-core/src/product-model-catalog.mjs"
import { createTaskChildPlanner } from "../../../../packages/rubato-runtime/src/components/task/planner"
import { liveModelCatalog } from "../../../../packages/task/src/tools/host/senpi-agent-host"
import { catalogForPicker } from "../../../t3-integration/src/model-catalog-order.mjs"
import { admitPickerItems } from "../../../pi-runtime/features/model-picker/catalog.mjs"

describe("picker and task model catalog parity", () => {
  const live = [
    { provider: "openai-codex", id: "gpt-5.6-sol", model: "sol" },
    { provider: "anthropic", id: "claude-fable-5-1", model: "fable" },
    { provider: "xai", id: "grok-4.6", model: "grok" },
    { provider: "cursor", id: "cursor-grok-4.6-high-fast", model: "cursor-fast" },
    { provider: "cursor", id: "composer-2.5", model: "composer" },
    { provider: "cursor", id: "secret-lab", model: "secret" },
    { provider: "unknown-lab", id: "secret", model: "lab" },
  ]

  test("#given one live registry #when CLI GUI agent and team lists are built #then they share the product catalog", () => {
    const cli = admitPickerItems(live, undefined, (a, b) => a === b).map((item) => `${item.provider}/${item.id}`)
    const gui = catalogForPicker(live).map((item) => `${item.provider}/${item.id}`)
    const tools = liveModelCatalog(() => ({ getAvailable: () => live }))
    expect(cli).toEqual(gui)
    expect(tools.list?.()).toEqual(gui)
    expect(gui.every((slug) => catalogSlugs().includes(slug))).toBe(true)
    expect(cli).not.toContain("cursor/secret-lab")
    expect(cli).toContain("cursor/cursor-grok-4.6")
    expect(cli).toContain("cursor/composer-2.5")
  })

  test("#given a Fast-only cursor row #when planned as an agent #then the picker identity is admitted", () => {
    const models = live.map(({ provider, id }) => ({ provider, id }))
    const planner = createTaskChildPlanner({}, () => ({
      getAvailable: () => models,
      find: (provider: string, modelId: string) =>
        models.find((model) => model.provider === provider && model.id === modelId),
    }))
    const admitted = planner({
      prompt: "Use Cursor Fast.",
      parent_session_id: "parent-1",
      depth: 0,
      model: "cursor/cursor-grok-4.6",
    })
    expect(admitted.kind).toBe("resolved")
    if (admitted.kind !== "resolved") return
    expect(admitted.plan.model).toBe("cursor/cursor-grok-4.6")
    const rejected = planner({
      prompt: "Use a secret.",
      parent_session_id: "parent-1",
      depth: 0,
      model: "cursor/secret-lab",
    })
    expect(rejected.kind).toBe("error")
  })
})
