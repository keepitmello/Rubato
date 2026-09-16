import { describe, expect, test } from "bun:test"

import { createTaskRecord } from "../state"
import { buildCompletionDetails, buildCompletionMessage } from "./notification"

describe("task completion model visibility", () => {
  test("#given internally routed model metadata #when completion enters model context #then only the public model contract remains", () => {
    // given
    const record = createTaskRecord({
      parent_session_id: "parent-session",
      root_session_id: "parent-session",
      depth: 1,
      execution_mode: "in-process",
      model: "requested/model",
      notify_on_terminal: false,
      resolved_model: {
        source: "model",
        provider: "quotio-openai",
        model_id: "gpt-5.6-luna-fast",
        display: "quotio-openai/gpt-5.6-luna-fast",
      },
    })
    const completed = {
      ...record,
      status: "completed" as const,
      final_response: "done",
    }

    // when
    const message = buildCompletionMessage([buildCompletionDetails(completed)])

    // then
    expect(message.content).toBe(`completed ${completed.task_id}`)
    expect(message.content).not.toContain("category:")
    expect(message.content).not.toContain("requested/model")
    expect(message.details[0]?.resolved_model?.display).toBe("quotio-openai/gpt-5.6-luna-fast")
    const serialized = JSON.stringify(message)
    expect(serialized).not.toContain("category")
    expect(serialized).not.toContain("preset")
    expect(serialized).not.toContain("preset")
    expect(serialized).not.toContain('"source"')
  })
})
