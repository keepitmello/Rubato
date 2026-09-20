import { describe, expect, test } from "bun:test"

import {
  PRODUCT_MODEL_ORDER,
  admitProductCatalogItems,
  availableProductModelIds,
  catalogSlugs,
  expandProductCatalogVisibility,
  isProductCatalogSlug,
  launchProductModel,
  productCatalogIdentity,
  productCatalogLabel,
  sortProductCatalogItems,
} from "./product-model-catalog"

describe("product model catalog", () => {
  test("#given live extras #when admitted #then only curated rows remain unless kept as current", () => {
    const models = [
      { provider: "openai", id: "gpt-6-astra" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "cursor", id: "cursor-grok-4.6" },
      { provider: "cursor", id: "cursor-grok-4.6-high-fast" },
      { provider: "unknown-lab", id: "secret" },
      { provider: "openai-codex", id: "gpt-5.4" },
    ]

    expect(admitProductCatalogItems(models).map((item: { provider: string; id: string }) => `${item.provider}/${item.id}`)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "cursor/cursor-grok-4.6",
    ])
    expect(admitProductCatalogItems([
      { provider: "cursor", id: "cursor-grok-4.6-high-fast" },
    ]).map((item: { provider: string; id: string }) => `${item.provider}/${item.id}`)).toEqual(["cursor/cursor-grok-4.6"])
    expect(
      admitProductCatalogItems(models, { keep: (item: { provider: string; id: string }) => item.provider === "openai-codex" && item.id === "gpt-5.4" })
        .map((item: { provider: string; id: string }) => `${item.provider}/${item.id}`),
    ).toEqual([
      "openai-codex/gpt-5.6-sol",
      "cursor/cursor-grok-4.6",
      "openai-codex/gpt-5.4",
    ])
  })

  test("#given a live Fast-only cursor row #when listed for spawn surfaces #then the picker identity is the available slug", () => {
    expect(availableProductModelIds([
      { provider: "cursor", id: "cursor-grok-4.6-high-fast" },
      { provider: "xai", id: "grok-4.6" },
      { provider: "cursor", id: "secret-lab" },
    ])).toEqual(["xai/grok-4.6", "cursor/cursor-grok-4.6"])
    expect(isProductCatalogSlug("cursor/cursor-grok-4.6-high-fast")).toBe(true)
    expect(isProductCatalogSlug("cursor/secret-lab")).toBe(false)
  })

  test("#given the picker identity #when launching a child #then --model is the live Fast row", () => {
    expect(productCatalogIdentity("cursor/cursor-grok-4.6-high-fast")).toBe("cursor/cursor-grok-4.6")
    expect(launchProductModel("cursor/cursor-grok-4.6")).toBe("cursor/cursor-grok-4.6-high-fast")
    expect(launchProductModel("xai/grok-4.6")).toBe("xai/grok-4.6")
    const visible = expandProductCatalogVisibility(new Set(["cursor/cursor-grok-4.6-high-fast"]))
    expect(visible.has("cursor/cursor-grok-4.6")).toBe(true)
  })

  test("#given mixed providers #when sorted #then Sol leads and cursor stays after xai", () => {
    const sorted = sortProductCatalogItems([
      { provider: "cursor", id: "composer-2.5" },
      { provider: "xai", id: "grok-4.6" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
    ])
    expect(sorted.map((item: { provider: string; id: string }) => `${item.provider}/${item.id}`)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "xai/grok-4.6",
      "cursor/composer-2.5",
    ])
    expect(productCatalogLabel({ provider: "cursor", id: "cursor-grok-4.6" })).toBe("Grok 4.6 fast")
    expect(productCatalogLabel({ provider: "cursor", id: "composer-2.5" })).toBe("Composer 2.5")
    expect(productCatalogLabel({ provider: "openai-codex", id: "gpt-6-astra" })).toBe("Astra 6")
    expect(productCatalogLabel({ provider: "xai", id: "grok-4.6" })).toBe("Grok 4.6")
    expect(catalogSlugs()[0]).toBe("openai-codex/gpt-5.6-sol")
    expect(catalogSlugs()).toContain("b-ai/deepseek-v4.1-flash")
    expect(productCatalogLabel({ provider: "b-ai", id: "deepseek-v4.1-flash" })).toBe("v4.1 Flash")
    expect(PRODUCT_MODEL_ORDER.cursor).toContain("composer-2.5")
  })

  test("#given anthropic account rows #when labeled #then sub is a picker suffix not a different model family", () => {
    expect(productCatalogLabel({ provider: "anthropic", id: "claude-opus-5" })).toBe("Opus 5")
    expect(productCatalogLabel({ provider: "anthropic", id: "claude-opus-5-sub" })).toBe("Opus 5 [sub]")
    expect(productCatalogLabel({ provider: "anthropic", id: "claude-fable-5-1-sub" })).toBe("Fable 5.1 [sub]")
    expect(isProductCatalogSlug("anthropic/claude-opus-5-sub")).toBe(true)
    expect(isProductCatalogSlug("anthropic/claude-fable-5-1-sub")).toBe(true)
    expect(admitProductCatalogItems([
      { provider: "anthropic", id: "claude-opus-5" },
      { provider: "anthropic", id: "claude-opus-5-sub" },
      { provider: "anthropic", id: "claude-fable-5-1" },
      { provider: "anthropic", id: "claude-fable-5-1-sub" },
    ]).map((item: { provider: string; id: string }) => `${item.provider}/${item.id}`)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-5-sub",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-fable-5-1-sub",
    ])
  })
})
