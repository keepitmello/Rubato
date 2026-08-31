import { describe, expect, test } from "bun:test"

import type { RubatoConfig } from "@rubato/config-core"

import type { TaskManager } from "../../manager"
import { createTaskTool } from "./tool"
import type { TaskToolDeps } from "./types"

const RUBATO_CONFIG: RubatoConfig = { categories: {}, agents: {} }

function notImplemented(name: string): never {
  throw new Error(`fake TaskManager.${name} not configured`)
}

function fakeManager(): TaskManager {
  return {
    start: () => notImplemented("start"),
    startOwned: () => notImplemented("startOwned"),
    findOwnedTask: () => undefined,
    continueTask: () => notImplemented("continueTask"),
    sendToTask: () => notImplemented("sendToTask"),
    interruptTask: () => notImplemented("interruptTask"),
    cancelTask: () => notImplemented("cancelTask"),
    get: () => undefined,
    list: () => [],
    waitFor: () => notImplemented("waitFor"),
    forget: () => {},
    getResidentHandle: () => undefined,
    subscribeChild: () => () => {},
    residentTaskIds: () => [],
    promoteToBackground: () => true,
    wasBackground: () => false,
    runStatsSnapshot: () => undefined,
  }
}

function createTool() {
  const deps: TaskToolDeps = {
    manager: fakeManager(),
    rubatoConfig: RUBATO_CONFIG,
    agents: { explore: { name: "explore", description: "Read-only code search" } },
    models: { has: () => true },
  }
  return createTaskTool(deps)
}

describe("task argument normalization", () => {
  test("#given padded model and preset fields #when arguments are prepared #then blanks drop and identifiers remain", () => {
    const tool = createTool()
    const prepareArguments = tool.prepareArguments
    expect(typeof prepareArguments).toBe("function")
    if (prepareArguments === undefined) throw new Error("task prepareArguments is missing")

    const prepared = prepareArguments({
      prompt: "TASK: Audit the task tool boundary.",
      model: "",
      preset: "explore",
      effort: "high",
      summary: "Audit spawn contract",
    })

    expect(prepared).toEqual({
      prompt: "TASK: Audit the task tool boundary.",
      preset: "explore",
      effort: "high",
      summary: "Audit spawn contract",
    })
  })

  test("#given an over-limit summary #when arguments are prepared #then the harness force-truncates it to the schema limit", () => {
    const tool = createTool()
    const prepareArguments = tool.prepareArguments
    if (prepareArguments === undefined) throw new Error("task prepareArguments is missing")

    const prepared = prepareArguments({
      prompt: "TASK: Audit the task tool boundary.",
      summary: `Audit ${"z".repeat(200)}`,
      preset: "explore",
    })

    expect(prepared.summary).toHaveLength(80)
    expect(prepared.summary?.endsWith("...")).toBe(true)
  })

  test("#given legacy task_summary #when arguments are prepared #then it maps to summary", () => {
    const tool = createTool()
    const prepareArguments = tool.prepareArguments
    if (prepareArguments === undefined) throw new Error("task prepareArguments is missing")

    const prepared = prepareArguments({
      prompt: "TASK: Audit the task tool boundary.",
      task_summary: "  Inspect the\n   schema surface  ",
      model: "xai/grok-4.6",
    })

    expect(prepared.summary).toBe("Inspect the schema surface")
    expect(prepared.model).toBe("xai/grok-4.6")
  })
})
