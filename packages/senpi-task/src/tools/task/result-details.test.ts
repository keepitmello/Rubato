import { expect, test } from "bun:test"

import { createTaskRecord } from "../../state"
import { recordDetails } from "./result-details"

test("#given a record with fallback attempts #when result details are built #then the renderer receives the recorded history", () => {
  // given
  const fallbackAttempts = [
    { provider: "kimi-coding", model_id: "kimi-for-coding-highspeed", display: "kimi-for-coding-highspeed", source: "model" as const },
    {
      provider: "quotio-openai",
      model_id: "gpt-5.6-luna-fast",
      display: "gpt-5.6-luna-fast",
      reasoning_effort: "high",
      source: "model" as const,
    },
  ]
  const record = createTaskRecord({
    parent_session_id: "session-parent",
    root_session_id: "session-root",
    depth: 0,
    execution_mode: "in-process",
    model: "quotio-openai/gpt-5.6-luna-fast",
    notify_on_terminal: false,
    fallback_attempts: fallbackAttempts,
  }, 1)

  // when
  const details = recordDetails(record, "spawn")

  // then
  expect(details.fallback_attempts).toEqual(fallbackAttempts.map(({ source: _source, ...attempt }) => attempt))
  const serialized = JSON.stringify(details)
  expect(serialized).not.toContain("category")
  expect(serialized).not.toContain("subagent_type")
  expect(serialized).not.toContain("agent_type")
  expect(serialized).not.toContain('"source"')
})

test("#given a record with a task_summary #when result details are built #then the summary reaches the renderer details", () => {
  // given
  const record = createTaskRecord({
    task_summary: "Audit the boundary",
    parent_session_id: "session-parent",
    root_session_id: "session-root",
    depth: 0,
    execution_mode: "in-process",
    model: "quotio-openai/gpt-5.6-luna-fast",
    notify_on_terminal: false,
  }, 1)

  // when
  const details = recordDetails(record, "spawn")

  // then
  expect(details.task_summary).toBe("Audit the boundary")
})
