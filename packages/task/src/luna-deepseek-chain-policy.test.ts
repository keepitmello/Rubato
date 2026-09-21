import { describe, expect, test } from "bun:test"
import { CATEGORY_FALLBACK_CHAINS } from "./category/fallback-chains"

const DEEPSEEK_OFF = {
  providers: ["deepseek"],
  model: "deepseek-v4-flash",
  variant: "off",
}

describe("Senpi Luna and DeepSeek chain policy", () => {
  test("quick places non-reasoning DeepSeek V4 Flash immediately after Luna", () => {
    const quick = CATEGORY_FALLBACK_CHAINS["quick"]

    expect(quick?.slice(1, 3)).toEqual([
      { providers: ["openai-codex"], model: "gpt-5.6-luna-fast", variant: "low" },
      DEEPSEEK_OFF,
    ])
  })
})
