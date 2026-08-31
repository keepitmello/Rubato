import { describe, expect, test } from "bun:test"

import { TASK_SUMMARY_MAX_LENGTH } from "../../task-summary"
import { TaskToolParams } from "./params"

describe("TaskToolParams", () => {
  test("#given the schema #when inspected #then it exposes only prompt model XOR preset effort and summary", () => {
    expect(TaskToolParams.type).toBe("object")
    expect(Object.keys(TaskToolParams.properties)).toEqual(["prompt", "model", "preset", "effort", "summary"])
  })

  test("#given the schema #when properties are inspected #then removed public fields are absent", () => {
    const propertyKeys = Object.keys(TaskToolParams.properties)

    expect(propertyKeys).not.toContain("category")
    expect(propertyKeys).not.toContain("subagent_type")
    expect(propertyKeys).not.toContain("run_in_background")
    expect(propertyKeys).not.toContain("load_skills")
    expect(propertyKeys).not.toContain("reasoning")
    expect(propertyKeys).not.toContain("tasks")
    expect(propertyKeys).not.toContain("task_summary")
    expect(propertyKeys).not.toContain("description")
    expect(propertyKeys).not.toContain("name")
  })

  test("#given the schema #when required fields are read #then prompt is required", () => {
    expect(TaskToolParams.required).toEqual(["prompt"])
  })

  test("#given the schema #when summary is inspected #then it sits after effort with the schema length limit", () => {
    const keys = Object.keys(TaskToolParams.properties)
    expect(keys.indexOf("summary")).toBe(keys.indexOf("effort") + 1)
    expect(TaskToolParams.properties.summary).toMatchObject({ maxLength: TASK_SUMMARY_MAX_LENGTH })
  })

  test("#given effort controls #when schemas are inspected #then only public Agent efforts are exposed", () => {
    const levels = TaskToolParams.properties.effort.anyOf.map((entry) => entry.const)
    expect(levels).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"])
  })
})
