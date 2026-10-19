import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { loadRubatoConfig } from "../index"

/**
 * Segno's home is a folder like any other, and the store its conversation writes to is the one its
 * own `.rubato/rubato.jsonc` names — not the leads' "rubato" store. The companion's folder is
 * `<home>/.rubato/companion`; the config it carries is what makes its memory its own.
 */
function folderWithStore(root: string, store: string): string {
  const dir = join(root, store)
  mkdirSync(join(dir, ".rubato"), { recursive: true })
  writeFileSync(join(dir, ".rubato", "rubato.jsonc"), JSON.stringify({ memory: { agent: store } }))
  return dir
}

describe("the companion folder's memory store", () => {
  test("#given the companion's own config and a lead's #when each folder loads #then each names its own store", () => {
    const root = mkdtempSync(join(tmpdir(), "rubato-segno-config-"))
    const homeDir = join(root, "home")
    const companion = folderWithStore(root, "segno")
    const lead = folderWithStore(root, "rubato")

    const companionConfig = loadRubatoConfig({ cwd: companion, env: { HOME: homeDir }, platform: "linux" })
    const leadConfig = loadRubatoConfig({ cwd: lead, env: { HOME: homeDir }, platform: "linux" })

    expect(companionConfig.diagnostics).toEqual([])
    expect(companionConfig.config.memory).toMatchObject({ agent: "segno" })
    expect(leadConfig.config.memory).toMatchObject({ agent: "rubato" })
  })

  test("#given no config of its own #when the companion folder loads #then no store is claimed", () => {
    const root = mkdtempSync(join(tmpdir(), "rubato-segno-config-"))
    const empty = join(root, "empty")
    mkdirSync(empty, { recursive: true })

    const config = loadRubatoConfig({ cwd: empty, env: { HOME: join(root, "home") }, platform: "linux" })

    expect(config.config.memory?.agent ?? "auto").toBe("auto")
  })
})
