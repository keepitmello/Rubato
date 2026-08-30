import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJsonObject(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isJsonObject(parsed)) throw new Error(`${path} must contain a JSON object`)
  return parsed
}

function readString(record: JsonObject, key: string): string {
  const value = record[key]
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function readBoolean(record: JsonObject, key: string): boolean {
  const value = record[key]
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

function readStringRecord(record: JsonObject, key: string): Record<string, string> {
  const value = record[key]
  if (value === undefined) return {}
  if (!isJsonObject(value)) throw new Error(`${key} must be an object`)

  const result: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") throw new Error(`${key}.${entryKey} must be a string`)
    result[entryKey] = entryValue
  }
  return result
}

function readObjectRecord(record: JsonObject, key: string): Record<string, JsonObject> {
  const value = record[key]
  if (!isJsonObject(value)) throw new Error(`${key} must be an object`)

  const result: Record<string, JsonObject> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (!isJsonObject(entryValue)) throw new Error(`${key}.${entryKey} must be an object`)
    result[entryKey] = entryValue
  }
  return result
}

function readStringArray(record: JsonObject, key: string): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${key} must be a string array`)
  }
  return value
}

describe("rubato-runtime package shape", () => {
  test("#given the senpi adapter manifest #when audited #then it declares the package contract", async () => {
    // given
    const [rootManifest, manifest] = await Promise.all([
      readJsonObject("package.json"),
      readJsonObject("packages/rubato-runtime/package.json"),
    ])

    // when
    const exportsMap = readObjectRecord(manifest, "exports")
    const scripts = readStringRecord(manifest, "scripts")
    const dependencies = readStringRecord(manifest, "dependencies")
    const devDependencies = readStringRecord(manifest, "devDependencies")
    const peerDependencies = readStringRecord(manifest, "peerDependencies")
    const peerDependenciesMeta = readObjectRecord(manifest, "peerDependenciesMeta")

    // then
    expect(readString(manifest, "name")).toBe("@rubato/runtime")
    expect(readBoolean(manifest, "private")).toBe(true)
    expect(readString(manifest, "type")).toBe("module")
    expect(readString(manifest, "version")).toBe(readString(rootManifest, "version"))
    expect(Object.keys(exportsMap).toSorted()).toEqual([".", "./extension"])
    expect(scripts).toMatchObject({
      typecheck: "tsgo --noEmit -p tsconfig.json",
      test: "bun test src/**/*.test.ts",
    })
    expect(peerDependencies["@code-yeongyu/senpi"]).toBe("2026.8.22")
    expect(peerDependenciesMeta["@code-yeongyu/senpi"]).toMatchObject({ optional: true })
    expect(devDependencies["@code-yeongyu/senpi"]).toBe("2026.8.22")
    expect(dependencies).toMatchObject({
      "@rubato/utils": "workspace:*",
      "@rubato/lsp-core": "workspace:*",
      "@rubato/memory-core": "workspace:*",
      "@rubato/senpi-task": "workspace:*",
      "@rubato/lsp-daemon": "file:../lsp-daemon",
    })
    expect(Object.keys(dependencies)).not.toContain(["vscode", "jsonrpc"].join("-"))
    expect(Object.keys(readStringRecord(rootManifest, "dependencies"))).not.toContain(["vscode", "jsonrpc"].join("-"))
  })

  test("#given the packaged senpi plugin manifest #when audited #then license and notice files ship with generated artifacts", async () => {
    // given
    const manifest = await readJsonObject("packages/rubato-runtime/plugin/package.json")

    // when
    const files = readStringArray(manifest, "files")

    // then
    expect(files).toContain("extensions")
    expect(files).toContain("runtime")
    expect(files).toContain("README.md")
    expect(files).toContain("NOTICE")
    expect(files).toContain("LICENSE")
  })

  test("#given root workspace metadata #when audited #then the senpi adapter is registered", async () => {
    // given
    const rootManifest = await readJsonObject("package.json")

    // when
    const workspaces = readStringArray(rootManifest, "workspaces")
    const typecheck = readString(readStringRecord(rootManifest, "scripts"), "typecheck")

    // then
    expect(workspaces).toContain("packages/rubato-runtime")
    expect(workspaces).toContain("packages/lsp-daemon")
    expect(typecheck).toContain("tsgo --noEmit -p packages/rubato-runtime/tsconfig.json")
  })
})
