import { describe, expect, it } from "bun:test"

import { createReflectionRunId } from "./identity-runtime"

describe("createReflectionRunId", () => {
  it("#given two processes that each start fresh #when both allocate a first id #then the ids differ", () => {
    // Durable records are keyed by run id. A per-process counter re-issued `reflection-run-1`
    // after every restart and wedged the scheduler on a mismatched completion record.
    const fixed = () => Date.UTC(2026, 8, 23, 4, 0, 0)
    expect(createReflectionRunId(fixed)).not.toBe(createReflectionRunId(fixed))
  })

  it("#given an id #when used as a record file name #then it is already a safe identifier", () => {
    const id = createReflectionRunId()
    expect(id).toMatch(/^reflection-\d{8}T\d{9}Z-[0-9a-f]{8}$/)
    expect(id.length).toBeLessThanOrEqual(80)
  })
})
