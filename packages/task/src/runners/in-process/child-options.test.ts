import { describe, expect, test } from "bun:test"
import type { SessionManager } from "@code-yeongyu/senpi"

import type { ChildSpec } from "../in-process"
import { buildChildSessionOptions } from "./child-options"

function spec(overrides: Partial<ChildSpec> = {}): ChildSpec {
  return {
    taskId: "st_1",
    cwd: "/tmp/project",
    sessionDir: "/tmp/project/sessions",
    depth: 1,
    parentSessionId: "parent",
    rootSessionId: "root",
    prompt: "do it",
    ...overrides,
  }
}

describe("buildChildSessionOptions service tier", () => {
  const sessionManager = {} as SessionManager

  test("#given no service tier #when child options are built #then no serviceTier field is set", () => {
    const options = buildChildSessionOptions({
      spec: spec(),
      sessionManager,
      sharedParentTools: [],
      uiOnlyToolNames: [],
    })

    expect("serviceTier" in options).toBe(false)
  })

  test("#given a requested tier #when child options are built #then serviceTier is attached", () => {
    const options = buildChildSessionOptions({
      spec: spec({ serviceTier: "priority" }),
      sessionManager,
      sharedParentTools: [],
      uiOnlyToolNames: [],
    })

    expect(options.serviceTier).toBe("priority")
  })
})
