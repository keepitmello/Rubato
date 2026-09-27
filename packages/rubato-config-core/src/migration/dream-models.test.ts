import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import { parseJsoncSafe } from "../internal/jsonc-parse"
import { loadRubatoConfig } from "../loader"
import { migrateDreamModelsDocument, migrateUserConfigDreamModels } from "./dream-models"

function userHome(content: string): { readonly home: string; readonly configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rubato-dream-models-migration-"))
  mkdirSync(join(home, ".rubato"), { recursive: true })
  const configPath = join(home, ".rubato", "rubato.jsonc")
  writeFileSync(configPath, content)
  return { home, configPath }
}

// The shape of a user config written while the dream named a category ladder.
const LEGACY_USER_CONFIG = `{
  "[senpi]": {
    // agents the harness does not route to
    "agents": { "explore": { "disable": true } },
    "categories": {
      "deep": { "model": "xai/grok-4.7", "reasoning": "medium" },
      // the ladder the dream runs on
      "grok": {
        "models": [
          { "model": "b-ai/deepseek-v4.1-flash", "reasoning": "medium" },
          { "model": "anthropic/claude-haiku-4-5", "reasoning": "off" }
        ]
      }
    },
    "task": { "max_depth": 1 }
  },
  "memory": {
    // the daily dream
    "dream": {
      "category": "grok",
      "publish": "review",
      "stores": { "rubato": { "enabled": true } }
    }
  }
}
`

describe("dream models migration", () => {
  test("#given a user config whose dream ran on a [senpi] category #when migrated #then the ladder lands in memory.dream.models, every categories key goes and comments stay", () => {
    // given
    const { home, configPath } = userHome(LEGACY_USER_CONFIG)

    // when
    const result = migrateUserConfigDreamModels({ env: { HOME: home } })

    // then
    expect(result?.status).toBe("migrated")
    const text = readFileSync(configPath, "utf-8")
    expect(text).toContain("// agents the harness does not route to")
    expect(text).toContain("// the daily dream")
    expect(text).not.toContain("categories")
    expect(text).not.toContain("\"category\"")
    expect(parseJsoncSafe(text).data).toEqual({
      "[senpi]": { agents: { explore: { disable: true } }, task: { max_depth: 1 } },
      memory: {
        dream: {
          publish: "review",
          stores: { rubato: { enabled: true } },
          models: [
            { model: "b-ai/deepseek-v4.1-flash", reasoning: "medium" },
            { model: "anthropic/claude-haiku-4-5", reasoning: "off" },
          ],
        },
      },
      _migrations: ["2026-09-dream-models"],
    })
    expect(loadRubatoConfig({ cwd: home, env: { HOME: home }, harness: "senpi" }).diagnostics).toEqual([])
    expect(readdirSync(join(home, ".rubato")).some((name) => name.includes(".bak."))).toBe(true)
  })

  test("#given a migrated config #when the migration runs again #then the file is left alone", () => {
    // given
    const { home, configPath } = userHome(LEGACY_USER_CONFIG)
    migrateUserConfigDreamModels({ env: { HOME: home } })
    const once = readFileSync(configPath, "utf-8")

    // when
    const again = migrateUserConfigDreamModels({ env: { HOME: home } })

    // then
    expect(again).toBeUndefined()
    expect(readFileSync(configPath, "utf-8")).toBe(once)
  })

  test("#given a config with no categories and no dream category #when migrated #then nothing is written, marker included", () => {
    // given
    const content = `{ "memory": { "dream": { "publish": "auto" } } }\n`
    const { home, configPath } = userHome(content)

    // when
    const result = migrateUserConfigDreamModels({ env: { HOME: home } })

    // then
    expect(result).toBeUndefined()
    expect(readFileSync(configPath, "utf-8")).toBe(content)
  })

  test("#given no user config #when migrated #then nothing is created", () => {
    const home = mkdtempSync(join(tmpdir(), "rubato-dream-models-migration-"))
    expect(migrateUserConfigDreamModels({ env: { HOME: home } })).toBeUndefined()
    expect(existsSync(join(home, ".rubato"))).toBe(false)
  })

  test("#given an unset dream category #when migrated #then the grok category supplies the ladder, top-level before [senpi]", () => {
    // given: model first with the category's reasoning, then models entries; [senpi] fields override top-level ones
    const document = {
      categories: { grok: { model: "xai/grok-4.7", reasoning: "high", models: ["b-ai/deepseek-v4.1-flash", "xai/grok-4.7"] } },
      "[senpi]": { categories: { grok: { reasoning: "medium" } } },
    }

    // when
    const migrated = migrateDreamModelsDocument(document)

    // then
    expect(migrated.document).toEqual({
      memory: { dream: { models: [{ model: "xai/grok-4.7", reasoning: "medium" }, { model: "b-ai/deepseek-v4.1-flash", reasoning: "medium" }] } },
    })
  })

  test("#given memory.dream.models already set #when migrated #then it is kept and only the dead keys go", () => {
    // given
    const document = {
      categories: { grok: { model: "xai/grok-4.7" } },
      task: { warnings: { unavailable_categories: false } },
      memory: { dream: { category: "grok", models: ["anthropic/claude-haiku-4-5"] } },
      profiles: { work: { categories: { deep: {} }, "[codex]": { categories: {} } } },
    }

    // when
    const migrated = migrateDreamModelsDocument(document)

    // then
    expect(migrated.document).toEqual({
      memory: { dream: { models: ["anthropic/claude-haiku-4-5"] } },
      profiles: { work: {} },
    })
  })

  test("#given a dream category with no usable models #when migrated #then models stays unset so the default ladder applies", () => {
    // given
    const document = { memory: { dream: { category: "missing" } } }

    // when
    const migrated = migrateDreamModelsDocument(document)

    // then
    expect(migrated.document).toEqual({})
    expect(migrated.diagnostics).toHaveLength(1)
  })
})
