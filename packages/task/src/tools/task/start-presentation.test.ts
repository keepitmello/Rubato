import { describe, expect, test } from "bun:test"

import { backgroundStartText } from "./start-presentation"

const STARTED = {
  kind: "started" as const,
  task_id: "st_00000001",
  status: "running" as const,
  name: "auditor",
}

describe("backgroundStartText", () => {
  test("#given a task_summary #when the start text is built #then the summary labels the task over description and name", () => {
    // given / when / then
    expect(backgroundStartText(STARTED, { taskSummary: "Audit the boundary" })).toContain(
      "Started agent Audit the boundary (st_00000001, running)",
    )
  })

  test("#given no labels #when the start text is built #then the name is used and the id form stays stable", () => {
    // given / when / then
    expect(backgroundStartText(STARTED, {})).toContain("Started agent auditor (st_00000001, running)")
    expect(backgroundStartText({ ...STARTED, name: STARTED.task_id }, {})).toContain("Started agent st_00000001 (running)")
  })
})
