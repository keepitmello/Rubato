import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { loadRubatoConfig } from "@rubato/config-core"
import { buildTaskToolDescription } from "@rubato/task"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { composeTaskEngine, type TaskEngine } from "./engine"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "rubato-runtime-engine-agents-"))
  tempRoots.push(dir)
  return dir
}

function composeIn(cwd: string): TaskEngine {
  return composeTaskEngine({
    pi: new FakeExtensionAPI(),
    rubatoConfig: loadRubatoConfig({ cwd }).config,
    cwd,
    sharedParentTools: () => [],
  })
}

function writeRubatoJson(cwd: string, config: unknown): void {
  mkdirSync(join(cwd, ".rubato"), { recursive: true })
  writeFileSync(join(cwd, ".rubato", "rubato.json"), `${JSON.stringify(config)}\n`)
}

// The rendered "Available presets: a, b, c" fragment of the Agent tool description.
function advertisedAgentNames(engine: TaskEngine): string {
  const description = buildTaskToolDescription({ rubatoConfig: engine.rubatoConfig, agents: engine.agents })
  const marker = "Available presets: "
  const start = description.indexOf(marker)
  if (start < 0) throw new Error("task tool description is missing the Available presets list")
  const rest = description.slice(start + marker.length)
  const names = rest.split(". CORRECT")[0] ?? rest
  const end = names.indexOf("\n")
  return (end < 0 ? names : names.slice(0, end)).trim()
}

describe("task engine agent overlay", () => {
  test("#given no rubato.json agents #when the engine resolves agents #then the roster is empty", () => {
    // given / when
    const engine = composeIn(tempProject())

    // then
    expect(Object.keys(engine.agents)).toEqual([])
  })

  test("#given a rubato.json agent #when the engine resolves agents #then the config definition is the roster", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, { agents: { scout: { description: "Project scout", prompt: "Scout the repo." } } })

    // when
    const engine = composeIn(cwd)

    // then
    expect(Object.keys(engine.agents)).toEqual(["scout"])
    expect(engine.agents["scout"]?.prompt).toBe("Scout the repo.")
  })

  test("#given a process-mode user agent #when the engine resolves agents #then its execution mode remains configurable", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, {
      agents: { scout: { description: "Project scout", execution_mode: "process" } },
    })

    // when
    const engine = composeIn(cwd)

    // then
    expect(engine.agents["scout"]?.executionMode).toBe("process")
  })

  test("#given the default engine agents #when the task tool description renders #then no presets are advertised", () => {
    // given
    const engine = composeIn(tempProject())

    // when / then
    expect(buildTaskToolDescription({ rubatoConfig: engine.rubatoConfig, agents: engine.agents }))
      .toContain("No presets are currently loaded; provide `model`.")
  })

  test("#given a rubato.json agent #when the description renders #then the preset is advertised", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, { agents: { scout: { description: "Project scout" } } })

    // when
    const engine = composeIn(cwd)

    // then
    expect(advertisedAgentNames(engine)).toBe("scout")
  })

  test("#given agents.scout.disable in rubato.json #when the description renders #then scout is hidden", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, { agents: { scout: { description: "Project scout", disable: true } } })

    // when
    const engine = composeIn(cwd)

    // then
    expect(engine.agents["scout"]?.disable).toBe(true)
    expect(buildTaskToolDescription({ rubatoConfig: engine.rubatoConfig, agents: engine.agents }))
      .toContain("No presets are currently loaded; provide `model`.")
  })
})
