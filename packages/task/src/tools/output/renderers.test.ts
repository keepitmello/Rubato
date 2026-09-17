import { describe, expect, test } from "bun:test"

import type { ThemeColor } from "@code-yeongyu/senpi"
import type { AgentSnapshot } from "@rubato/agent-core"

import { rendererVisibleWidth } from "../task/renderers"
import { toolResult } from "../control"
import { renderTaskOutputCall, renderTaskOutputResult, type OutputRenderTheme } from "./renderers"
import type { TaskOutputDetails } from "./types"

const TEST_THEME: OutputRenderTheme = {
  fg: (color: ThemeColor, text: string) => `[${color}]${text}[/${color}]`,
}

const ANSI_THEME: OutputRenderTheme = {
  fg: (_color: ThemeColor, text: string) => `\u001b[33m${text}\u001b[0m`,
}

const RESULT_OPTIONS = { expanded: false, isPartial: false }
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u

function firstLine(component: { render(width: number): string[] }, width: number): string {
  return component.render(width)[0] ?? ""
}

function expectNoTerminalControls(value: string): void {
  expect(value).not.toMatch(TERMINAL_CONTROL_PATTERN)
}

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    agentId: "st_done",
    status: "completed",
    model: "raw-model",
    ...overrides,
  }
}

describe("AgentOutput renderers", () => {
  test("#given AgentOutput arguments #when rendering calls #then rows show target mode peek and only relevant tail lines", () => {
    const tailLine = firstLine(
      renderTaskOutputCall({ agentId: "long-running-explorer", mode: "tail", tail_lines: 20 }, TEST_THEME),
      96,
    )
    const statusLine = firstLine(
      renderTaskOutputCall({ agentId: "st_1", mode: "status", tail_lines: 20 }, TEST_THEME),
      96,
    )

    expect(tailLine).toContain("AgentOutput")
    expect(tailLine).toContain("target:long-running-explorer")
    expect(tailLine).toContain("mode:tail")
    expect(tailLine).toContain("peek")
    expect(tailLine).toContain("tail_lines:20")
    expect(statusLine).toContain("peek")
    expect(statusLine).not.toContain("tail_lines")
  })

  test("#given a long multiline Korean and English target #when rendering with ANSI at width 72 #then target is normalized truncated and column-safe", () => {
    const line = firstLine(
      renderTaskOutputCall(
        {
          agentId: "한국어 작업 이름이 아주 길게 이어집니다.\nEnglish task name also continues long enough to require truncation.",
          mode: "tail",
          tail_lines: 7,
        },
        ANSI_THEME,
      ),
      72,
    )

    expect(line).not.toContain("\n")
    expect(line).toContain("한국어 작업")
    expect(line).toContain("...")
    expect(rendererVisibleWidth(line)).toBeLessThanOrEqual(72)
  })

  test("#given a width smaller than the fixed call tokens #when rendering AgentOutput #then the complete ANSI row is clamped", () => {
    const line = firstLine(
      renderTaskOutputCall({ agentId: "abcdef", mode: "status" }, ANSI_THEME),
      20,
    )

    expect(line).toContain("...")
    expect(rendererVisibleWidth(line)).toBeLessThanOrEqual(20)
  })

  test("#given every result detail kind #when rendering compact rows #then rows are exhaustive and transcripts are not echoed", () => {
    const details: readonly TaskOutputDetails[] = [
      { kind: "status", snapshot: snapshot({ status: "running" }) },
      {
        kind: "transcript",
        mode: "full",
        source: "event-log",
        transcript: "secret transcript body that must stay out of compact rows",
        truncated: true,
        snapshot: snapshot(),
      },
      { kind: "not_found", reason: "No task 'missing' in this session.", known_agents: ["alpha"] },
      { kind: "invalid_arguments", reason: "agentId is required" },
    ]

    const lines = details.map((detail) => firstLine(renderTaskOutputResult(toolResult("ignored", detail), RESULT_OPTIONS, TEST_THEME), 120))

    expect(lines).toHaveLength(details.length)
    expect(lines.join("\n")).toContain("AgentOutput st_done running")
    expect(lines.join("\n")).toContain("AgentOutput transcript st_done")
    expect(lines.join("\n")).toContain("source:event-log")
    expect(lines.join("\n")).toContain("truncated")
    expect(lines.join("\n")).toContain("AgentOutput not found")
    expect(lines.join("\n")).toContain("known:alpha")
    expect(lines.join("\n")).toContain("AgentOutput invalid")
    expect(lines.join("\n")).not.toContain("secret transcript body")
  })

  test("#given a host snapshot #when the status row renders #then agentId status and model are shown", () => {
    const line = firstLine(
      renderTaskOutputResult(
        toolResult("ignored", { kind: "status", snapshot: snapshot({ model: "xai/grok-4.6", effort: "high" }) }),
        RESULT_OPTIONS,
        TEST_THEME,
      ),
      200,
    )

    expect(line).toContain("AgentOutput st_done completed")
    expect(line).toContain("model:xai/grok-4.6")
    expect(line).toContain("effort:high")
  })

  test("#given long multiline Korean and English known tasks #when rendering not_found at width 96 #then known list is normalized truncated and column-safe", () => {
    const detail: TaskOutputDetails = {
      kind: "not_found",
      reason: "No task 'missing' in this session.",
      known_agents: [
        "한국어 알려진 작업 이름이 아주 길게 이어집니다.\nEnglish known task also continues long enough to require truncation.",
      ],
    }

    const line = firstLine(renderTaskOutputResult(toolResult("ignored", detail), RESULT_OPTIONS, ANSI_THEME), 96)

    expect(line).not.toContain("\n")
    expect(line).toContain("한국어 알려진")
    expect(line).toContain("...")
    expect(rendererVisibleWidth(line)).toBeLessThanOrEqual(96)
  })

  test("#given injected controls in a AgentOutput result #when rendered #then dynamic controls are removed before trusted theme styling", () => {
    const details: TaskOutputDetails = {
      kind: "invalid_arguments",
      reason: "누락 \u001b[31m빨강\u001b[0m \u001b]8;;https://example.com\u001b\\링크\u001b]8;;\u001b\\\u0007",
    }

    const themed = firstLine(renderTaskOutputResult(toolResult("ignored", details), RESULT_OPTIONS, ANSI_THEME), 120)
    const plain = firstLine(renderTaskOutputResult(toolResult("ignored", details), RESULT_OPTIONS, TEST_THEME), 120)

    expect(themed).toStartWith("\u001b[33m")
    expect(themed).not.toContain("\u001b[31m")
    expect(themed).not.toContain("https://example.com")
    expectNoTerminalControls(plain)
  })
})
