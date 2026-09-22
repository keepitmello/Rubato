import { describe, expect, test } from "bun:test"

import {
  CURSOR_GROK_BASE_ID,
  CURSOR_GROK_DEFAULT_FAST_ID,
  CURSOR_GROK_PRESENTED_ID,
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

// 세대 id 는 카탈로그가 소유한다. 여기서 손으로 다시 적으면 세대가 바뀔 때마다
// 테스트가 먼저 깨지고, 고치는 일은 값을 다시 베끼는 일이 된다.
const XAI_GROK = PRODUCT_MODEL_ORDER.xai[0]
const BAI_FLASH = PRODUCT_MODEL_ORDER["b-ai"][0]
const [FABLE, OPUS] = PRODUCT_MODEL_ORDER.anthropic
const pick = (item: { provider: string; id: string }) => `${item.provider}/${item.id}`

describe("product model catalog", () => {
  test("#given live extras #when admitted #then only curated rows remain unless kept as current", () => {
    const models = [
      { provider: "openai", id: "gpt-6-astra" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "cursor", id: CURSOR_GROK_BASE_ID },
      { provider: "cursor", id: `${CURSOR_GROK_BASE_ID}-high-fast` },
      { provider: "unknown-lab", id: "secret" },
      { provider: "openai-codex", id: "gpt-5.4" },
    ]

    expect(admitProductCatalogItems(models).map(pick)).toEqual([
      "openai-codex/gpt-5.6-sol",
      CURSOR_GROK_PRESENTED_ID,
    ])
    expect(admitProductCatalogItems([
      { provider: "cursor", id: `${CURSOR_GROK_BASE_ID}-high-fast` },
    ]).map(pick)).toEqual([CURSOR_GROK_PRESENTED_ID])
    expect(
      admitProductCatalogItems(models, { keep: (item: { provider: string; id: string }) => item.provider === "openai-codex" && item.id === "gpt-5.4" })
        .map(pick),
    ).toEqual([
      "openai-codex/gpt-5.6-sol",
      CURSOR_GROK_PRESENTED_ID,
      "openai-codex/gpt-5.4",
    ])
  })

  test("#given a live Fast-only cursor row #when listed for spawn surfaces #then the picker identity is the available slug", () => {
    expect(availableProductModelIds([
      { provider: "cursor", id: `${CURSOR_GROK_BASE_ID}-high-fast` },
      { provider: "xai", id: XAI_GROK },
      { provider: "cursor", id: "secret-lab" },
    ])).toEqual([`xai/${XAI_GROK}`, CURSOR_GROK_PRESENTED_ID])
    expect(isProductCatalogSlug(CURSOR_GROK_DEFAULT_FAST_ID)).toBe(true)
    expect(isProductCatalogSlug("cursor/secret-lab")).toBe(false)
  })

  test("#given the picker identity #when launching a child #then --model is the live Fast row", () => {
    expect(productCatalogIdentity(CURSOR_GROK_DEFAULT_FAST_ID)).toBe(CURSOR_GROK_PRESENTED_ID)
    expect(launchProductModel(CURSOR_GROK_PRESENTED_ID)).toBe(CURSOR_GROK_DEFAULT_FAST_ID)
    expect(launchProductModel(`xai/${XAI_GROK}`)).toBe(`xai/${XAI_GROK}`)
    const visible = expandProductCatalogVisibility(new Set([CURSOR_GROK_DEFAULT_FAST_ID]))
    expect(visible.has(CURSOR_GROK_PRESENTED_ID)).toBe(true)
  })

  test("#given mixed providers #when sorted #then Sol leads and cursor stays after xai", () => {
    const sorted = sortProductCatalogItems([
      { provider: "cursor", id: "composer-2.5" },
      { provider: "xai", id: XAI_GROK },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
    ])
    expect(sorted.map(pick)).toEqual([
      "openai-codex/gpt-5.6-sol",
      `xai/${XAI_GROK}`,
      "cursor/composer-2.5",
    ])
    // 라벨 텍스트는 세대별 사실이다 — 세대가 바뀌면 사람이 한 번 확인한다.
    expect(productCatalogLabel({ provider: "cursor", id: CURSOR_GROK_BASE_ID })).toBe("Grok 4.7 fast")
    expect(productCatalogLabel({ provider: "cursor", id: "composer-2.5" })).toBe("Composer 2.5")
    expect(productCatalogLabel({ provider: "openai-codex", id: "gpt-6-astra" })).toBe("Astra 6")
    expect(productCatalogLabel({ provider: "xai", id: XAI_GROK })).toBe("Grok 4.7")
    expect(catalogSlugs()[0]).toBe("openai-codex/gpt-5.6-sol")
    expect(catalogSlugs()).toContain(`b-ai/${BAI_FLASH}`)
    expect(productCatalogLabel({ provider: "b-ai", id: BAI_FLASH })).toBe("v4.1 Flash")
    expect(PRODUCT_MODEL_ORDER.cursor).toContain("composer-2.5")
  })

  test("#given anthropic account rows #when labeled #then sub is a picker suffix not a different model family", () => {
    // 라벨 텍스트는 세대별 사실이다 (Opus/Fable 의 현재 세대 이름).
    expect(productCatalogLabel({ provider: "anthropic", id: OPUS })).toBe("Opus 5.5")
    expect(productCatalogLabel({ provider: "anthropic", id: `${OPUS}-sub` })).toBe("Opus 5.5 [sub]")
    expect(productCatalogLabel({ provider: "anthropic", id: `${FABLE}-sub` })).toBe("Fable 5.1 [sub]")
    expect(isProductCatalogSlug(`anthropic/${OPUS}-sub`)).toBe(true)
    expect(isProductCatalogSlug(`anthropic/${FABLE}-sub`)).toBe(true)
    expect(admitProductCatalogItems([
      { provider: "anthropic", id: OPUS },
      { provider: "anthropic", id: `${OPUS}-sub` },
      { provider: "anthropic", id: FABLE },
      { provider: "anthropic", id: `${FABLE}-sub` },
    ]).map(pick)).toEqual([
      `anthropic/${OPUS}`,
      `anthropic/${OPUS}-sub`,
      `anthropic/${FABLE}`,
      `anthropic/${FABLE}-sub`,
    ])
    expect(availableProductModelIds([
      { provider: "anthropic", id: FABLE },
      { provider: "anthropic", id: `${FABLE}-sub` },
      { provider: "anthropic", id: OPUS },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-5.6-sol-sub" },
    ])).toEqual([
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-sol-sub",
      `anthropic/${FABLE}`,
      `anthropic/${FABLE}-sub`,
      `anthropic/${OPUS}`,
    ])
  })
})
