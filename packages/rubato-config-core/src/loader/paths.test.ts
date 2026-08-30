import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { resolveHomeDir, resolveRubatoConfigPaths, resolveUserRubatoConfigDirectory, resolveUserRubatoConfigPath } from "./paths"

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), "rubato-config-paths-"))
  const homeDir = join(root, "home")
  mkdirSync(homeDir, { recursive: true })
  return homeDir
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

describe("resolveHomeDir", () => {
  test("#given an absolute POSIX HOME #when resolving on any host #then its filesystem root is preserved", () => {
    expect(resolveHomeDir({ HOME: "/home/alice" })).toBe("/home/alice")
  })
})

describe("resolveUserRubatoConfigDirectory", () => {
  test("#given a HOME #when resolving the user config directory #then it is ~/.rubato", () => {
    // given
    const homeDir = makeHome()

    // when
    const directory = resolveUserRubatoConfigDirectory({ HOME: homeDir })

    // then
    expect(directory).toBe(join(homeDir, ".rubato"))
  })

  test("#given XDG_CONFIG_HOME is set #when resolving the user config directory #then it is ignored in favour of ~/.rubato", () => {
    // given
    const homeDir = makeHome()
    const xdgConfigHome = join(homeDir, "xdg")

    // when
    const directory = resolveUserRubatoConfigDirectory({ HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome })

    // then
    expect(directory).toBe(join(homeDir, ".rubato"))
  })

  test("#given APPDATA set #when resolving the user config directory #then it is ignored in favour of ~/.rubato", () => {
    // given
    const homeDir = makeHome()
    const appData = join(homeDir, "AppData", "Roaming")

    // when
    const directory = resolveUserRubatoConfigDirectory({ HOME: homeDir, APPDATA: appData })

    // then
    expect(directory).toBe(join(homeDir, ".rubato"))
  })

  test("#given USERPROFILE instead of HOME #when resolving the user config directory #then it is <USERPROFILE>/.rubato", () => {
    // given
    const homeDir = makeHome()

    // when
    const directory = resolveUserRubatoConfigDirectory({ USERPROFILE: homeDir })

    // then
    expect(directory).toBe(join(homeDir, ".rubato"))
  })
})

describe("resolveUserRubatoConfigPath", () => {
  test("#given a HOME #when resolving the user config path #then it is ~/.rubato/rubato.jsonc", () => {
    // given
    const homeDir = makeHome()

    // when
    const path = resolveUserRubatoConfigPath({ HOME: homeDir })

    // then
    expect(path).toBe(join(homeDir, ".rubato", "rubato.jsonc"))
  })
})

describe("resolveRubatoConfigPaths user candidate", () => {
  test("#given ~/.rubato/rubato.jsonc exists #when resolving candidates #then the user candidate is that file", () => {
    // given
    const homeDir = makeHome()
    const cwd = join(homeDir, "work")
    mkdirSync(cwd, { recursive: true })
    writeFile(join(homeDir, ".rubato", "rubato.jsonc"), "{}")

    // when
    const candidates = resolveRubatoConfigPaths({ cwd, env: { HOME: homeDir }, platform: "linux" })

    // then
    expect(candidates[0]).toEqual({ path: join(homeDir, ".rubato", "rubato.jsonc"), scope: "user" })
  })

  test("#given only ~/.rubato/rubato.json exists #when resolving candidates #then the json fallback is selected", () => {
    // given
    const homeDir = makeHome()
    const cwd = join(homeDir, "work")
    mkdirSync(cwd, { recursive: true })
    writeFile(join(homeDir, ".rubato", "rubato.json"), "{}")

    // when
    const candidates = resolveRubatoConfigPaths({ cwd, env: { HOME: homeDir }, platform: "linux" })

    // then
    expect(candidates[0]).toEqual({ path: join(homeDir, ".rubato", "rubato.json"), scope: "user" })
  })

  test("#given a file under ~/.config and no ~/.rubato config #when resolving candidates #then the ~/.config file is never selected", () => {
    // given
    const homeDir = makeHome()
    const cwd = join(homeDir, "work")
    const unusedPath = join(homeDir, ".config", "other-app", "rubato.jsonc")
    mkdirSync(cwd, { recursive: true })
    writeFile(unusedPath, `{"task":{"default_concurrency":42}}`)

    // when
    const candidates = resolveRubatoConfigPaths({ cwd, env: { HOME: homeDir }, platform: "linux" })

    // then
    expect(candidates.map((candidate) => candidate.path)).not.toContain(unusedPath)
    expect(candidates[0]).toEqual({ path: join(homeDir, ".rubato", "rubato.jsonc"), scope: "user" })
  })

  test("#given a project .rubato config #when resolving candidates #then the user candidate stays first and project layers follow", () => {
    // given
    const homeDir = makeHome()
    const projectDir = join(homeDir, "work", "project")
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(homeDir, ".rubato", "rubato.jsonc"), "{}")
    writeFile(join(projectDir, ".rubato", "rubato.jsonc"), "{}")

    // when
    const candidates = resolveRubatoConfigPaths({ cwd: projectDir, env: { HOME: homeDir }, platform: "linux" })

    // then
    expect(candidates).toEqual([
      { path: join(homeDir, ".rubato", "rubato.jsonc"), scope: "user" },
      { path: join(projectDir, ".rubato", "rubato.jsonc"), scope: "project" },
    ])
  })
})
