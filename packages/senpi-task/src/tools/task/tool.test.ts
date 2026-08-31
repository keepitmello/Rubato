import { describe, expect, test } from "bun:test"

import type { Theme } from "@code-yeongyu/senpi"
import type { RubatoConfig } from "@rubato/config-core"

import type { TaskManager } from "../../manager"
import { rendererVisibleWidth } from "./renderers"
import { TASK_TOOL_NAME, createTaskTool } from "./tool"
import type { TaskToolDeps } from "./types"

const RUBATO_CONFIG: RubatoConfig = {
  categories: { "release-crew": { description: "Ships the release train" } },
  agents: {},
}

const ANSI_ITALIC = "\u001b[3m"
const ANSI_ITALIC_END = "\u001b[23m"

const RENDERER_THEME = {
  fg: (_color, text) => `\u001b[36m${text}\u001b[39m`,
  italic: (text) => `${ANSI_ITALIC}${text}${ANSI_ITALIC_END}`,
} satisfies Pick<Theme, "fg" | "italic">

function notImplemented(name: string): never {
  throw new Error(`fake TaskManager.${name} not configured`)
}

function fakeManager(overrides: Partial<TaskManager>): TaskManager {
  return {
    start: () => notImplemented("start"),
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
    ...overrides,
  }
}

function deps(manager: TaskManager): TaskToolDeps {
  return {
    manager,
    rubatoConfig: RUBATO_CONFIG,
    agents: { explore: { name: "explore", description: "Codebase search" } },
    models: { has: () => true },
  }
}

function renderedLines(component: unknown, width: number): string[] {
  if (typeof component !== "object" || component === null) throw new Error("renderer did not return a component")
  const render = Reflect.get(component, "render")
  if (typeof render !== "function") throw new Error("renderer component is missing render()")
  const rendered: unknown = Reflect.apply(render, component, [width])
  if (!Array.isArray(rendered)) throw new Error("renderer component did not return lines")
  const lines: string[] = []
  for (const line of rendered) {
    if (typeof line !== "string") throw new Error("renderer component returned a non-string line")
    lines.push(line)
  }
  return lines
}

describe("createTaskTool", () => {
  test("#given deps #when the tool is created #then it exposes the senpi ToolDefinition surface", () => {
    // given
    const tool = createTaskTool(deps(fakeManager({})))

    // then
    expect(tool.name).toBe(TASK_TOOL_NAME)
    expect(tool.label.length).toBeGreaterThan(0)
    expect(tool.parameters.type).toBe("object")
    expect(typeof tool.execute).toBe("function")
    expect(tool.promptSnippet).toBeTruthy()
    expect(Array.isArray(tool.promptGuidelines)).toBe(true)
    expect(typeof tool.renderCall).toBe("function")
    expect(typeof tool.renderResult).toBe("function")
  })

  test("#given loaded agents #when the description is read #then it lists presets and omits categories", () => {
    const tool = createTaskTool(deps(fakeManager({})))

    expect(tool.description).toContain("explore")
    expect(tool.description).toContain("Available presets")
    expect(tool.description).not.toContain("release-crew")
    expect(tool.description).not.toContain("subagent_type")
  })

  test("#given the assembled tool #when parameters are read #then prompt is required and batch fields are absent", () => {
    const tool = createTaskTool(deps(fakeManager({})))

    expect(tool.parameters.required).toEqual(["prompt"])
    expect(Object.keys(tool.parameters.properties)).toEqual(["prompt", "model", "preset", "effort", "summary"])
  })

  test("#given the real task call renderer #when rendered at 72 columns #then actual prompt and italic background mode are visible", () => {
    // given
    const tool = createTaskTool(deps(fakeManager({})))
    const renderCall = tool.renderCall
    if (renderCall === undefined) throw new Error("task renderCall is missing")

    // when
    const component: unknown = Reflect.apply(renderCall, undefined, [
      {
        prompt: "실제 프롬프트입니다. This extra text forces a concise excerpt in the task row.",
        model: "xai/grok-4.6",
      },
      RENDERER_THEME,
      {},
    ])
    const [row = ""] = renderedLines(component, 72)

    // then
    expect(row).toContain("실제 프롬프트")
    expect(row).toContain(`${ANSI_ITALIC}background${ANSI_ITALIC_END}`)
    expect(rendererVisibleWidth(row)).toBeLessThanOrEqual(72)
  })

  test("#given a category task call #when rendered #then the call row is prompt-only without category or model", () => {
    // given
    const tool = createTaskTool(deps(fakeManager({})))
    const renderCall = tool.renderCall
    if (renderCall === undefined) throw new Error("task renderCall is missing")

    // when
    const component: unknown = Reflect.apply(renderCall, undefined, [
      { prompt: "Inspect task rendering", model: "xai/grok-4.6" },
      RENDERER_THEME,
      {},
    ])
    const [row = ""] = renderedLines(component, 120)

    // then
    expect(row).toContain('Agent "Inspect task rendering"')
    expect(row).not.toContain("quick")
    expect(row).not.toContain("category:")
    expect(row).toContain(`${ANSI_ITALIC}background${ANSI_ITALIC_END}`)
  })

  test("#given an agent task call #when rendered #then the call row is prompt-only without the agent target", () => {
    // given
    const tool = createTaskTool(deps(fakeManager({})))
    const renderCall = tool.renderCall
    if (renderCall === undefined) throw new Error("task renderCall is missing")

    // when
    const component: unknown = Reflect.apply(renderCall, undefined, [
      { prompt: "Inspect task rendering", preset: "atlas" },
      RENDERER_THEME,
      {},
    ])
    const [row = ""] = renderedLines(component, 120)

    // then
    expect(row).toContain('Agent "Inspect task rendering"')
    expect(row).not.toContain("agent:atlas")
  })

  test("#given a partial child progress result #when rendered #then only the last-line row renders (status lives in senpi's progress line)", () => {
    const tool = createTaskTool(deps(fakeManager({})))
    const renderResult = tool.renderResult
    if (renderResult === undefined) throw new Error("task renderResult is missing")

    const component: unknown = Reflect.apply(renderResult, undefined, [
      {
        content: [{ type: "text", text: "↳ last: found it" }],
        details: { task_id: "st_1", status: "running", mode: "spawn" },
      },
      { expanded: false, isPartial: true },
      RENDERER_THEME,
      {},
    ])

    expect(renderedLines(component, 120)).toEqual(["\u001b[36m↳ last: found it\u001b[39m"])
  })

  test("#given a partial result with empty content #when rendered #then no extra rows render below the call line", () => {
    const tool = createTaskTool(deps(fakeManager({})))
    const renderResult = tool.renderResult
    if (renderResult === undefined) throw new Error("task renderResult is missing")

    const component: unknown = Reflect.apply(renderResult, undefined, [
      {
        content: [{ type: "text", text: "" }],
        details: { task_id: "st_1", status: "running", mode: "spawn" },
      },
      { expanded: false, isPartial: true },
      RENDERER_THEME,
      {},
    ])

    expect(renderedLines(component, 120)).toEqual([])
  })

  test("#given the real task result renderer #when a category result is rendered #then resolved context and italic foreground mode are visible", () => {
    // given
    const tool = createTaskTool(deps(fakeManager({})))
    const renderResult = tool.renderResult
    if (renderResult === undefined) throw new Error("task renderResult is missing")

    // when
    const component: unknown = Reflect.apply(renderResult, undefined, [
      {
        content: [{ type: "text", text: "queued" }],
        details: {
          task_id: "st_0000000f",
          status: "pending",
          mode: "spawn",
          category: "quick",
          resolved_model: {
            provider: "openai",
            model_id: "gpt-5.6-sol",
            display: "GPT-5.6 Sol",
            reasoning_effort: "xhigh",
            source: "category",
          },
                  },
      },
      { expanded: false, isPartial: false },
      RENDERER_THEME,
      {},
    ])
    const [row = ""] = renderedLines(component, 72)

    // then
    expect(row).toContain("category:quick(openai/gpt-5.6-sol:xhigh)")
    expect(row).toContain(`${ANSI_ITALIC}background${ANSI_ITALIC_END}`)
    expect(rendererVisibleWidth(row)).toBeLessThanOrEqual(72)
  })

  test("#given an ultrabrain background result #when rendered at 72 columns #then every required context token remains complete", () => {
    // given
    const tool = createTaskTool(deps(fakeManager({})))
    const renderResult = tool.renderResult
    if (renderResult === undefined) throw new Error("task renderResult is missing")

    // when
    const component: unknown = Reflect.apply(renderResult, undefined, [
      {
        content: [{ type: "text", text: "running" }],
        details: {
          task_id: "st_019f4d02",
          status: "running",
          mode: "spawn",
          category: "ultrabrain",
          resolved_model: {
            provider: "rubato-mock",
            model_id: "mock-1",
            display: "rubato-mock/mock-1",
            reasoning_effort: "xhigh",
            source: "category",
          },
                  },
      },
      { expanded: false, isPartial: false },
      RENDERER_THEME,
      {},
    ])
    const [row = ""] = renderedLines(component, 72)

    // then
    expect(row).toContain("category:ultrabrain")
    expect(row).toContain("rubato-mock/mock-1")
    expect(row).toContain("xhigh")
    expect(row).toContain(`${ANSI_ITALIC}background${ANSI_ITALIC_END}`)
    expect(row).toContain("running")
    expect(row).not.toContain("backgrou...")
    expect(rendererVisibleWidth(row)).toBeLessThanOrEqual(72)
  })
})
