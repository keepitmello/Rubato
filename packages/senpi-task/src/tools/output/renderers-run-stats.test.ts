import { describe, expect, test } from "bun:test"

import type { ThemeColor } from "@code-yeongyu/senpi"
import type { AgentSnapshot } from "@rubato/agent-core"

import { toolResult } from "../control"
import { renderTaskOutputResult, type OutputRenderTheme } from "./renderers"
import type { TaskOutputDetails } from "./types"

const TEST_THEME: OutputRenderTheme = {
  fg: (_color: ThemeColor, text: string) => text,
}

const RESULT_OPTIONS = { expanded: false, isPartial: false }

describe("AgentOutput host snapshot rendering", () => {
  test("#given a completed host snapshot #when the status row renders #then agentId and status stay adjacent", () => {
    const snapshot: AgentSnapshot = {
      agentId: "st_done",
      status: "completed",
      model: "raw-model",
    }
    const details: TaskOutputDetails = { kind: "status", snapshot }

    const [line = ""] = renderTaskOutputResult(toolResult("ignored", details), RESULT_OPTIONS, TEST_THEME).render(200)

    expect(line).toContain("AgentOutput st_done completed")
    expect(line).toContain("model:raw-model")
    expect(line).not.toContain("ran ")
    expect(line).not.toContain("tok/s")
  })
})
