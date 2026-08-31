import { describe, expect, test } from "bun:test"

import { TaskSendParams } from "./send"

describe("TaskSendParams", () => {
  test("#given the AgentSend schema #when inspected #then it exposes only agentId and message", () => {
    const keys = Object.keys(TaskSendParams.properties)

    expect(keys).toEqual(["agentId", "message"])
    expect(keys).not.toContain("to")
    expect(keys).not.toContain("task_id")
    expect(keys).not.toContain("name")
    expect(keys).not.toContain("all_scope")
    expect(keys).not.toContain("team_run_id")
    expect(keys).not.toContain("summary")
  })
})
