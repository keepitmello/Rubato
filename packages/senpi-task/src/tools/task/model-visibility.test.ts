import { describe, expect, test } from "bun:test"

import type { StartResult } from "../../manager"
import { CTX, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"
import { taskResultLines } from "./renderers"

const RESOLVED_MODEL = {
  source: "explicit" as const,
  provider: "quotio-openai",
  model_id: "gpt-5.6-luna-fast",
  display: "quotio-openai/gpt-5.6-luna-fast",
}

describe("agent model visibility", () => {
  test("#given an exact model spawn #when the start is rendered #then the result names the resolved model", async () => {
    const started: StartResult = {
      kind: "started",
      task_id: "st_model",
      status: "running",
      name: "model-audit",
      resolved_model: RESOLVED_MODEL,
    }
    const manager = createFakeManager({
      start: async () => started,
      get: () => ({ task_id: "st_model", status: "running", name: "model-audit", resolved_model: RESOLVED_MODEL, execution_mode: "in-process" } as never),
    })

    const output = await buildTaskExecute(makeDeps(manager))(
      "call-model",
      { prompt: "audit the model", model: "quotio-openai/gpt-5.6-luna-fast" },
      undefined,
      undefined,
      CTX,
    )
    const [line] = taskResultLines(output.details)

    expect(line).toContain("quotio-openai/gpt-5.6-luna-fast")
    expect(output.details.resolved_model).toEqual(RESOLVED_MODEL)
  })
})
