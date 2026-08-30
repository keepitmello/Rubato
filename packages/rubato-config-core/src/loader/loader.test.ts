import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { loadRubatoConfig } from "../index"

function writeJsonc(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

function makeFixture(): {
  readonly homeDir: string
  readonly workDir: string
  readonly projectDir: string
  readonly cwd: string
} {
  const root = mkdtempSync(join(tmpdir(), "rubato-config-loader-"))
  const homeDir = join(root, "home")
  const workDir = join(homeDir, "work")
  const projectDir = join(workDir, "project")
  const cwd = join(projectDir, "child")
  mkdirSync(cwd, { recursive: true })
  return { homeDir, workDir, projectDir, cwd }
}

describe("loadRubatoConfig", () => {
  test("#given user and walked project rubato configs #when loading #then nearest project wins and keyed sections deep-merge", () => {
    // given
    const fixture = makeFixture()
    writeJsonc(
      join(fixture.homeDir, ".rubato", "rubato.jsonc"),
      `{
        "categories": {
          "quick": { "model": "user-model", "tools": { "read": true } }
        },
        "agents": {
          "reviewer": { "model": "user-agent", "tools": { "bash": false } }
        },
        "task": { "default_concurrency": 2, "wait": { "default_ms": 11000 } },
        "teams": {
          "alpha": {
            "members": [{ "name": "one", "kind": "category", "category": "quick", "prompt": "go" }]
          }
        }
      }`,
    )
    writeJsonc(
      join(fixture.workDir, ".rubato", "rubato.jsonc"),
      `{
        "categories": {
          "quick": { "model": "far-model", "tools": { "bash": true } },
          "deep": { "model": "deep-model" }
        },
        "agents": { "reviewer": { "temperature": 0.3 } },
        "task": { "default_concurrency": 4, "wait": { "max_ms": 90000 } }
      }`,
    )
    writeJsonc(
      join(fixture.projectDir, ".rubato", "rubato.jsonc"),
      `{
        "categories": { "quick": { "model": "near-model" } },
        "agents": { "reviewer": { "model": "near-agent" } },
        "task": { "default_concurrency": 7 }
      }`,
    )
    // when
    const result = loadRubatoConfig({
      cwd: fixture.cwd,
      env: { HOME: fixture.homeDir },
      platform: "linux",
    })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config.task?.default_concurrency).toBe(7)
    expect(result.config.task?.wait.default_ms).toBe(11000)
    expect(result.config.task?.wait.max_ms).toBe(90000)
    expect(result.config.categories?.quick?.model).toBe("near-model")
    expect(result.config.categories?.quick?.tools).toEqual({ read: true, bash: true })
    expect(result.config.categories?.deep?.model).toBe("deep-model")
    expect(result.config.agents?.reviewer?.model).toBe("near-agent")
    expect(result.config.agents?.reviewer?.temperature).toBe(0.3)
    expect(result.config.teams?.alpha?.members[0]?.name).toBe("one")
    expect("polluted" in Object.prototype).toBe(false)
  })

  test("#given same-key partial team layers #when loading #then final team merges members and description", () => {
    // given
    const fixture = makeFixture()
    writeJsonc(
      join(fixture.homeDir, ".rubato", "rubato.jsonc"),
      `{
        "teams": {
          "alpha": {
            "members": [{ "name": "one", "kind": "category", "category": "quick", "prompt": "go" }]
          }
        }
      }`,
    )
    writeJsonc(
      join(fixture.projectDir, ".rubato", "rubato.jsonc"),
      `{
        "teams": {
          "alpha": {
            "description": "near layer description"
          }
        }
      }`,
    )

    // when
    const result = loadRubatoConfig({
      cwd: fixture.cwd,
      env: { HOME: fixture.homeDir },
      platform: "linux",
    })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config.teams?.alpha?.description).toBe("near layer description")
    expect(result.config.teams?.alpha?.members[0]?.name).toBe("one")
  })

  test("#given symlinked project .rubato directory #when loading #then target config is ignored", () => {
    // given
    const fixture = makeFixture()
    const outsideConfigDir = join(fixture.homeDir, "outside-rubato")
    mkdirSync(outsideConfigDir, { recursive: true })
    writeJsonc(join(outsideConfigDir, "rubato.jsonc"), `{"task":{"default_concurrency":9}}`)
    symlinkSync(outsideConfigDir, join(fixture.projectDir, ".rubato"))

    // when
    const result = loadRubatoConfig({
      cwd: fixture.cwd,
      env: { HOME: fixture.homeDir },
      platform: "linux",
    })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.config.task?.default_concurrency).toBe(5)
    expect(result.sources.some((source) => source.scope === "project" && source.loaded)).toBe(false)
  })

  for (const extension of ["jsonc", "json"] as const) {
    test(`#given symlinked project rubato ${extension} file #when loading #then target config is ignored`, () => {
      // given
      const fixture = makeFixture()
      const projectRubatoDir = join(fixture.projectDir, ".rubato")
      const outsideConfigPath = join(fixture.homeDir, `outside.${extension}`)
      const projectConfigPath = join(projectRubatoDir, `rubato.${extension}`)
      mkdirSync(projectRubatoDir, { recursive: true })
      writeJsonc(outsideConfigPath, `{"task":{"default_concurrency":9}}`)
      symlinkSync(outsideConfigPath, projectConfigPath)

      // when
      const result = loadRubatoConfig({
        cwd: fixture.cwd,
        env: { HOME: fixture.homeDir },
        platform: "linux",
      })

      // then
      expect(result.diagnostics).toEqual([])
      expect(result.config.task?.default_concurrency).toBe(5)
      expect(result.sources.some((source) => source.scope === "project" && source.loaded)).toBe(false)
    })
  }

  test("#given malformed and unreadable configs #when loading #then defaults survive and typed diagnostics identify paths", () => {
    // given
    const fixture = makeFixture()
    const unreadablePath = join(fixture.projectDir, ".rubato", "rubato.jsonc")
    writeJsonc(join(fixture.homeDir, ".rubato", "rubato.jsonc"), `{"task":{"default_concurrency":"five"}}`)
    writeJsonc(unreadablePath, `{"task":{"default_concurrency":3}}`)

    // when
    const result = loadRubatoConfig({
      cwd: fixture.cwd,
      env: { HOME: fixture.homeDir },
      fileSystem: {
        existsSync: () => true,
        readFileSync: (path: string) => {
          if (path === unreadablePath) throw new Error("EACCES synthetic")
          return `{"task":{"default_concurrency":"five"}}`
        },
      },
      platform: "linux",
    })

    // then
    expect(result.config.task?.default_concurrency).toBe(5)
    expect(result.diagnostics.map((diagnostic: { readonly kind: string }) => diagnostic.kind)).toContain("validation")
    expect(result.diagnostics.map((diagnostic: { readonly kind: string }) => diagnostic.kind)).toContain("read")
    expect(result.diagnostics.some((diagnostic: { readonly path: string }) => diagnostic.path === unreadablePath)).toBe(true)
  })

  test("#given only user rubato json #when loading #then user json is read and jsonc takes precedence when both exist", () => {
    // given
    const jsonOnlyFixture = makeFixture()
    const jsonOnlyPath = join(jsonOnlyFixture.homeDir, ".rubato", "rubato.json")
    writeJsonc(jsonOnlyPath, `{"task":{"default_concurrency":9}}`)

    // when
    const jsonOnly = loadRubatoConfig({
      cwd: jsonOnlyFixture.cwd,
      env: { HOME: jsonOnlyFixture.homeDir },
      platform: "linux",
    })

    // then
    expect(jsonOnly.diagnostics).toEqual([])
    expect(jsonOnly.config.task?.default_concurrency).toBe(9)
    expect(jsonOnly.sources[0]).toEqual({ exists: true, loaded: true, path: jsonOnlyPath, scope: "user" })

    // given
    const bothFixture = makeFixture()
    const jsoncPath = join(bothFixture.homeDir, ".rubato", "rubato.jsonc")
    const jsonPath = join(bothFixture.homeDir, ".rubato", "rubato.json")
    writeJsonc(jsonPath, `{"task":{"default_concurrency":8}}`)
    writeJsonc(jsoncPath, `{"task":{"default_concurrency":4}}`)

    // when
    const both = loadRubatoConfig({
      cwd: bothFixture.cwd,
      env: { HOME: bothFixture.homeDir },
      platform: "linux",
    })

    // then
    expect(both.diagnostics).toEqual([])
    expect(both.config.task?.default_concurrency).toBe(4)
    expect(both.sources[0]).toEqual({ exists: true, loaded: true, path: jsoncPath, scope: "user" })
  })

  test("#given a rubato config carrying a $schema key #when loading #then the key is tolerated with no diagnostics and does not disturb the real config sections", () => {
    // given
    const schemaUrl = "https://example.com/rubato.schema.json"
    const fixture = makeFixture()
    const userPath = join(fixture.homeDir, ".rubato", "rubato.jsonc")
    writeJsonc(
      userPath,
      `{
        "$schema": "${schemaUrl}",
        "task": { "default_concurrency": 3 }
      }`,
    )

    // when
    const result = loadRubatoConfig({
      cwd: fixture.cwd,
      env: { HOME: fixture.homeDir },
      platform: "linux",
    })

    // then
    expect(result.diagnostics).toEqual([])
    expect(result.sources[0]).toEqual({ exists: true, loaded: true, path: userPath, scope: "user" })
    expect(result.config.task?.default_concurrency).toBe(3)
    expect(result.config.$schema).toBe(schemaUrl)
  })
})

test("#given cwd outside home #when loading #then ancestor project configs are read", () => {
  // given
  const root = mkdtempSync(join(tmpdir(), "rubato-config-outside-home-"))
  const homeDir = join(root, "home")
  const outsideProject = join(root, "elsewhere", "project")
  mkdirSync(outsideProject, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  writeJsonc(join(homeDir, ".rubato", "rubato.jsonc"), `{"task":{"default_concurrency":2}}`)
  writeJsonc(join(outsideProject, ".rubato", "rubato.jsonc"), `{"task":{"default_concurrency":7}}`)
  writeJsonc(join(root, "elsewhere", ".rubato", "rubato.jsonc"), `{"task":{"default_concurrency":9}}`)

  // when
  const result = loadRubatoConfig({
    cwd: outsideProject,
    env: { HOME: homeDir },
    platform: "linux",
  })

  // then
  expect(result.config.task?.default_concurrency).toBe(7)
  expect(result.sources.some((source) => source.path.endsWith(join("elsewhere", ".rubato", "rubato.jsonc")))).toBe(true)
})
