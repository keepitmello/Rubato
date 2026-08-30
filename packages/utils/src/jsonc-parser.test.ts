import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { clearPluginConfigFileDetectionCache, detectConfigFile, detectPluginConfigFile, parseJsonc, parseJsoncSafe, readJsoncFile } from "./jsonc-parser"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const pluginConfigDetectionOptions = {
  basenames: ["rubato"],
  legacyBasenames: ["rubato-legacy"],
} as const

describe("parseJsonc", () => {
  test("parses plain JSON", () => {
    // given
    const json = `{"key": "value"}`

    // when
    const result = parseJsonc<{ key: string }>(json)

    // then
    expect(result.key).toBe("value")
  })

  test("parses JSONC with line comments", () => {
    // given
    const jsonc = `{
      // This is a comment
      "key": "value"
    }`

    // when
    const result = parseJsonc<{ key: string }>(jsonc)

    // then
    expect(result.key).toBe("value")
  })

  test("parses JSONC with block comments", () => {
    // given
    const jsonc = `{
      /* Block comment */
      "key": "value"
    }`

    // when
    const result = parseJsonc<{ key: string }>(jsonc)

    // then
    expect(result.key).toBe("value")
  })

  test("parses JSONC with multi-line block comments", () => {
    // given
    const jsonc = `{
      /* Multi-line
         comment
         here */
      "key": "value"
    }`

    // when
    const result = parseJsonc<{ key: string }>(jsonc)

    // then
    expect(result.key).toBe("value")
  })

  test("parses JSONC with trailing commas", () => {
    // given
    const jsonc = `{
      "key1": "value1",
      "key2": "value2",
    }`

    // when
    const result = parseJsonc<{ key1: string; key2: string }>(jsonc)

    // then
    expect(result.key1).toBe("value1")
    expect(result.key2).toBe("value2")
  })

  test("parses JSONC with trailing comma in array", () => {
    // given
    const jsonc = `{
      "arr": [1, 2, 3,]
    }`

    // when
    const result = parseJsonc<{ arr: number[] }>(jsonc)

    // then
    expect(result.arr).toEqual([1, 2, 3])
  })

  test("preserves URLs with // in strings", () => {
    // given
    const jsonc = `{
      "url": "https://example.com"
    }`

    // when
    const result = parseJsonc<{ url: string }>(jsonc)

    // then
    expect(result.url).toBe("https://example.com")
  })

  test("parses complex JSONC config", () => {
    // given
    const jsonc = `{
      // This is an example config
      "agents": {
        "oracle": { "model": "openai/gpt-5.4" }, // GPT for strategic reasoning
      },
      /* Agent overrides */
      "disabled_agents": [],
    }`

    // when
    const result = parseJsonc<{
      agents: { oracle: { model: string } }
      disabled_agents: string[]
    }>(jsonc)

    // then
    expect(result.agents.oracle.model).toBe("openai/gpt-5.4")
    expect(result.disabled_agents).toEqual([])
  })

  test("throws on invalid JSON", () => {
    // given
    const invalid = `{ "key": invalid }`

    // when
    // then
    expect(() => parseJsonc(invalid)).toThrow()
  })

  test("throws on unclosed string", () => {
    // given
    const invalid = `{ "key": "unclosed }`

    // when
    // then
    expect(() => parseJsonc(invalid)).toThrow()
  })

  test("parses content with UTF-8 BOM prefix", () => {
    // given
    const jsonc = `\uFEFF{"key": "value"}`

    // when
    const result = parseJsonc<{ key: string }>(jsonc)

    // then
    expect(result.key).toBe("value")
  })

  test("parses commented JSONC with UTF-8 BOM prefix", () => {
    // given
    const jsonc = `\uFEFF{
      // Windows-saved file with BOM
      "$schema": "https://opencode.ai/config.json",
      "plugin": ["rubato@3.15.3"],
    }`

    // when
    const result = parseJsonc<{ $schema: string; plugin: string[] }>(jsonc)

    // then
    expect(result.$schema).toBe("https://opencode.ai/config.json")
    expect(result.plugin).toEqual(["rubato@3.15.3"])
  })
})

describe("parseJsoncSafe", () => {
  test("returns data on valid JSONC", () => {
    // given
    const jsonc = `{ "key": "value" }`

    // when
    const result = parseJsoncSafe<{ key: string }>(jsonc)

    // then
    expect(result.data).not.toBeNull()
    expect(result.data?.key).toBe("value")
    expect(result.errors).toHaveLength(0)
  })

  test("returns errors on invalid JSONC", () => {
    // given
    const invalid = `{ "key": invalid }`

    // when
    const result = parseJsoncSafe(invalid)

    // then
    expect(result.data).toBeNull()
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test("returns data when content has UTF-8 BOM prefix", () => {
    // given
    const jsonc = `\uFEFF{"key": "value"}`

    // when
    const result = parseJsoncSafe<{ key: string }>(jsonc)

    // then
    expect(result.errors).toHaveLength(0)
    expect(result.data).not.toBeNull()
    expect(result.data?.key).toBe("value")
  })
})

describe("readJsoncFile", () => {
  const testDir = join(__dirname, ".test-jsonc")
  const testFile = join(testDir, "fixture.jsonc")

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("reads and parses valid JSONC file", () => {
    // given
    const content = `{
      // Comment
      "test": "value"
    }`
    writeFileSync(testFile, content)

    // when
    const result = readJsoncFile<{ test: string }>(testFile)

    // then
    expect(result).not.toBeNull()
    expect(result?.test).toBe("value")
  })

  test("returns null for non-existent file", () => {
    // given
    const nonExistent = join(testDir, "does-not-exist.jsonc")

    // when
    const result = readJsoncFile(nonExistent)

    // then
    expect(result).toBeNull()
  })

  test("returns null for malformed JSON", () => {
    // given
    writeFileSync(testFile, "{ invalid }")

    // when
    const result = readJsoncFile(testFile)

    // then
    expect(result).toBeNull()
  })

  test("reads JSONC file written with UTF-8 BOM (Windows scenario)", () => {
    // given
    const bomBytes = Buffer.from([0xef, 0xbb, 0xbf])
    const jsonBytes = Buffer.from(`{
      // Created on Windows with BOM
      "$schema": "https://opencode.ai/config.json",
      "plugin": ["rubato@3.15.3"]
    }`)
    writeFileSync(testFile, Buffer.concat([bomBytes, jsonBytes]))

    // when
    const result = readJsoncFile<{ $schema: string; plugin: string[] }>(testFile)

    // then
    expect(result).not.toBeNull()
    expect(result?.$schema).toBe("https://opencode.ai/config.json")
    expect(result?.plugin).toEqual(["rubato@3.15.3"])
  })
})

describe("detectConfigFile", () => {
  const testDir = join(__dirname, ".test-detect")

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test.each([
    ["prefers .jsonc over .json", ["json", "jsonc"], "jsonc"],
    ["detects .json when .jsonc doesn't exist", ["json"], "json"],
  ] as const)("%s", (_label, extensions, expectedFormat) => {
    // given
    mkdirSync(testDir, { recursive: true })
    const basePath = join(testDir, "config")
    for (const extension of extensions) {
      writeFileSync(`${basePath}.${extension}`, "{}")
    }

    // when
    const result = detectConfigFile(basePath)

    // then
    expect(result.format).toBe(expectedFormat)
    expect(result.path).toBe(`${basePath}.${expectedFormat}`)
  })

  test("returns none when neither exists", () => {
    // given
    const basePath = join(testDir, "nonexistent")

    // when
    const result = detectConfigFile(basePath)

    // then
    expect(result.format).toBe("none")
  })
})

describe("detectPluginConfigFile", () => {
  const testDir = join(__dirname, ".test-detect-plugin")

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    clearPluginConfigFileDetectionCache()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    clearPluginConfigFileDetectionCache()
  })

  test("prefers rubato over rubato-legacy when both jsonc files exist", () => {
    // given
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "rubato.jsonc"), "{}")
    writeFileSync(join(testDir, "rubato-legacy.jsonc"), "{}")

    // when
    const result = detectPluginConfigFile(testDir, pluginConfigDetectionOptions)

    // then
    expect(result.format).toBe("jsonc")
    expect(result.path).toBe(join(testDir, "rubato.jsonc"))
    expect(result.legacyPath).toBe(join(testDir, "rubato-legacy.jsonc"))
  })

  test("falls back to rubato-legacy when rubato doesn't exist", () => {
    // given
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "rubato-legacy.jsonc"), "{}")

    // when
    const result = detectPluginConfigFile(testDir, pluginConfigDetectionOptions)

    // then
    expect(result.format).toBe("jsonc")
    expect(result.path).toBe(join(testDir, "rubato-legacy.jsonc"))
    expect(result.legacyPath).toBeUndefined()
  })

  test("loads rubato.json before rubato-legacy.json when no jsonc exists", () => {
    // given
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "rubato.json"), "{}")
    writeFileSync(join(testDir, "rubato-legacy.json"), "{}")

    // when
    const result = detectPluginConfigFile(testDir, pluginConfigDetectionOptions)

    // then
    expect(result.format).toBe("json")
    expect(result.path).toBe(join(testDir, "rubato.json"))
    expect(result.legacyPath).toBe(join(testDir, "rubato-legacy.json"))
  })

  test("returns none when no config files exist", () => {
    // given
    const emptyDir = join(testDir, "empty")
    mkdirSync(emptyDir, { recursive: true })

    // when
    const result = detectPluginConfigFile(emptyDir, pluginConfigDetectionOptions)

    // then
    expect(result.format).toBe("none")
    expect(result.path).toBe(join(emptyDir, "rubato.json"))
  })

  test("prefers canonical jsonc over legacy json when both exist", () => {
    // given
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "rubato-legacy.json"), "{}")
    writeFileSync(join(testDir, "rubato.jsonc"), "{}")

    // when
    const result = detectPluginConfigFile(testDir, pluginConfigDetectionOptions)

    // then
    expect(result.format).toBe("jsonc")
    expect(result.path).toBe(join(testDir, "rubato.jsonc"))
    expect(result.legacyPath).toBe(join(testDir, "rubato-legacy.json"))
  })

  test("loads rubato when only canonical jsonc exists", () => {
    // given
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "rubato.jsonc"), "{}")

    // when
    const result = detectPluginConfigFile(testDir, pluginConfigDetectionOptions)

    // then
    expect(result.format).toBe("jsonc")
    expect(result.path).toBe(join(testDir, "rubato.jsonc"))
    expect(result.legacyPath).toBeUndefined()
  })
})
