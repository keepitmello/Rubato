import { describe, expect, test } from "bun:test"

import { catalogSlugs, isProductCatalogSlug, PRODUCT_MODEL_ORDER } from "../../../../packages/model-core/src/product-model-catalog.mjs"
import { createTaskChildPlanner } from "../../../../packages/rubato-runtime/src/components/task/planner"
import { liveModelCatalog } from "../../../../packages/task/src/tools/host/senpi-agent-host"
import { catalogForPicker } from "../../../t3-integration/src/model-catalog-order.mjs"
import { admitPickerItems } from "../../../pi-runtime/features/model-picker/catalog.mjs"
import { CODEX_PICKER_IDS } from "../../src/picker-catalog.mjs"

const ASTRA_6 = CODEX_PICKER_IDS.find((id: string) => /^gpt-\d+-astra$/.test(id))
const ASTRA_6_SLUG = `openai-codex/${ASTRA_6}`
const SOL = PRODUCT_MODEL_ORDER["openai-codex"][0]
const FABLE = PRODUCT_MODEL_ORDER.anthropic[0]
const FABLE_SUB_SLUG = `anthropic/${FABLE}-sub`

describe("picker and task model catalog parity", () => {
  const live = [
    { provider: "openai-codex", id: SOL, model: "sol" },
    { provider: "openai-codex", id: `${SOL}-sub`, model: "sol-sub" },
    { provider: "openai-codex", id: ASTRA_6, model: "astra-6" },
    { provider: "anthropic", id: FABLE, model: "fable" },
    { provider: "anthropic", id: `${FABLE}-sub`, model: "fable-sub" },
    { provider: "xai", id: "grok-4.7", model: "grok" },
    { provider: "cursor", id: "grok-4.7-high-fast", model: "cursor-fast" },
    { provider: "cursor", id: "composer-2.5", model: "composer" },
    { provider: "cursor", id: "secret-lab", model: "secret" },
    { provider: "unknown-lab", id: "secret", model: "lab" },
  ]

  test("#given one live registry #when CLI GUI agent and team lists are built #then they share the product catalog", () => {
    const cli = admitPickerItems(live, undefined, (a, b) => a === b).map((item) => `${item.provider}/${item.id}`)
    const gui = catalogForPicker(live).map((item) => `${item.provider}/${item.id}`)
    const tools = liveModelCatalog(() => ({ getAvailable: () => live }), { agyModels: () => [] })
    expect(new Set(cli)).toEqual(new Set(gui))
    expect(new Set(tools.list?.())).toEqual(new Set(gui))
    expect(gui.every((slug) => isProductCatalogSlug(slug))).toBe(true)
    expect(gui.filter((slug) => !slug.endsWith("-sub")).every((slug) => catalogSlugs().includes(slug))).toBe(true)
    expect(cli).not.toContain("cursor/secret-lab")
    expect(cli).toContain("cursor/grok-4.7")
    expect(cli).toContain("cursor/composer-2.5")
    expect(cli).toContain(FABLE_SUB_SLUG)
    expect(cli).toContain(`openai-codex/${SOL}-sub`)
    expect(cli).toContain(ASTRA_6_SLUG)
  })

  test("Astra 6 is resolved as its own subagent model", () => {
    const planner = createTaskChildPlanner({}, () => ({
      getAvailable: () => live,
      find: (provider: string, id: string) => live.find((model) => model.provider === provider && model.id === id),
    }))
    const admitted = planner({
      prompt: "Reply OK.",
      parent_session_id: "parent-1",
      depth: 0,
      model: ASTRA_6_SLUG,
    })
    expect(admitted.kind === "resolved" && admitted.plan.model).toBe(ASTRA_6_SLUG)
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
      model: "cursor/grok-4.7",
    })
    expect(admitted.kind).toBe("resolved")
    if (admitted.kind !== "resolved") return
    expect(admitted.plan.model).toBe("cursor/grok-4.7")
    const rejected = planner({
      prompt: "Use a secret.",
      parent_session_id: "parent-1",
      depth: 0,
      model: "cursor/secret-lab",
    })
    expect(rejected.kind).toBe("error")
  })

  test("#given a live [sub] account row #when planned as an agent #then the picker identity is admitted", () => {
    const models = live.map(({ provider, id }) => ({ provider, id }))
    const planner = createTaskChildPlanner({}, () => ({
      getAvailable: () => models,
      find: (provider: string, modelId: string) =>
        models.find((model) => model.provider === provider && model.id === modelId),
    }))
    const admitted = planner({
      prompt: "Use Fable on the second account.",
      parent_session_id: "parent-1",
      depth: 0,
      model: FABLE_SUB_SLUG,
    })
    expect(admitted.kind).toBe("resolved")
    if (admitted.kind !== "resolved") return
    expect(admitted.plan.model).toBe(FABLE_SUB_SLUG)
  })
})
