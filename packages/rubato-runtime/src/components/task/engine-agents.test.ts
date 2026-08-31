import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { loadRubatoConfig } from "@rubato/config-core"
import { BUILTIN_AGENTS, buildTaskToolDescription } from "@rubato/senpi-task"

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

// The rendered "Available presets: a, b, c" fragment of the Agent tool description. The example line
// quoting preset="momus" must never leak into this extraction, so the marker anchors it.
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

function advertisedPlanGatedAgentNames(engine: TaskEngine): string {
  const description = buildTaskToolDescription({ rubatoConfig: engine.rubatoConfig, agents: engine.agents })
  const marker =
    "Plan-gated presets (spawnable only after the user explicitly requests the ulw-plan workflow, a .rubato/plans/*.md plan artifact was touched in this session, and start-work was never invoked): "
  const start = description.indexOf(marker)
  if (start < 0) throw new Error("task tool description is missing the Plan-gated presets list")
  const rest = description.slice(start + marker.length)
  const end = rest.indexOf("\n")
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

describe("task engine builtin agent overlay", () => {
  test("#given no rubato.json agents #when the engine resolves agents #then the builtin curated agents are present", () => {
    // given / when
    const engine = composeIn(tempProject())

    // then
    expect(Object.keys(engine.agents).sort()).toEqual(["explore", "librarian", "metis", "momus"])
    expect(engine.agents["explore"]?.executionMode).toBe("in-process")
  })

  test("#given an rubato.json model override for a builtin agent #when the engine resolves agents #then the model wins and the builtin prompt and allowlist survive", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, { agents: { explore: { model: "acme/custom-1" } } })

    // when
    const engine = composeIn(cwd)

    // then
    const explore = engine.agents["explore"]
    expect(explore?.model).toBe("acme/custom-1")
    expect(explore?.prompt).toBe(BUILTIN_AGENTS["explore"]?.prompt)
    expect(explore?.tools).toHaveLength(9)
  })

  test("#given an rubato.json-only agent #when the engine resolves agents #then it is appended alongside the builtins", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, { agents: { scout: { description: "Project scout", prompt: "Scout the repo." } } })

    // when
    const engine = composeIn(cwd)

    // then
    expect(Object.keys(engine.agents).sort()).toEqual(["explore", "librarian", "metis", "momus", "scout"])
    expect(engine.agents["scout"]?.prompt).toBe("Scout the repo.")
  })

  test("#given a process override for a curated agent #when the engine resolves agents #then in-process execution remains pinned", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, { agents: { explore: { execution_mode: "process" } } })

    // when
    const engine = composeIn(cwd)

    // then
    expect(engine.agents["explore"]?.executionMode).toBe("in-process")
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

  test("#given the default engine agents #when the task tool description renders #then plain builtins are advertised and the plan-gated tier is classified separately", () => {
    // given
    const engine = composeIn(tempProject())

    // when / then
    expect(advertisedAgentNames(engine)).toBe("explore, librarian")
    expect(advertisedPlanGatedAgentNames(engine)).toBe("metis, momus")
  })

  test("#given agents.momus.disable in rubato.json #when the description renders #then momus is hidden and the other three stay listed", () => {
    // given
    const cwd = tempProject()
    writeRubatoJson(cwd, { agents: { momus: { disable: true } } })

    // when
    const engine = composeIn(cwd)

    // then
    expect(engine.agents["momus"]?.disable).toBe(true)
    expect(advertisedAgentNames(engine)).toBe("explore, librarian")
    expect(advertisedPlanGatedAgentNames(engine)).toBe("metis")
  })
})
