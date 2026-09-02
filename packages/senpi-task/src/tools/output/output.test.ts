import { describe, expect, test } from "bun:test"

import type { ResolvedModelRecord, TaskRecord } from "../../state"
import { makeRecord } from "./__fixtures__/records"
import { runTaskOutput, TaskOutputParams } from "./output"
import type { OutputManager, TaskOutputDeps, TaskOutputToolResult, TranscriptReadResult } from "./types"

function managerFrom(records: readonly TaskRecord[]): OutputManager {
  return {
    get: (taskId) => records.find((record) => record.task_id === taskId),
  }
}

function depsFrom(records: readonly TaskRecord[], reader?: () => TranscriptReadResult): TaskOutputDeps {
  return {
    manager: managerFrom(records),
    stateDir: "/tmp/state",
    now: () => Date.parse("2024-12-03T15:00:00.000Z"),
    transcriptReader: reader ?? (() => ({ entries: [], source: "none" })),
  }
}

function firstText(result: TaskOutputToolResult): string {
  const first = result.content[0]
  return first?.type === "text" ? first.text : ""
}

describe("runTaskOutput", () => {
  test("#given the AgentOutput schema #when inspected #then it exposes agentId and hides name/task_id", () => {
    const keys = Object.keys(TaskOutputParams.properties)

    expect(keys).toContain("agentId")
    expect(keys).not.toContain("name")
    expect(keys).not.toContain("task_id")
    expect(keys).not.toContain("to")
  })

  test("#given a completed task in tail mode #when read #then the last assistant text is present", async () => {
    const record = makeRecord({ task_id: "st_done", status: "completed", final_response: "all done" })
    const deps = depsFrom([record], () => ({
      entries: [
        { kind: "assistant", text: "starting the work" },
        { kind: "tool", tool: "bash", is_error: false },
        { kind: "assistant", text: "finished the work" },
      ],
      source: "event-log",
    }))

    const result = await runTaskOutput(deps, { agentId: "st_done", mode: "tail" }, "session-parent")

    expect(result.details.kind).toBe("transcript")
    if (result.details.kind === "transcript") {
      expect(result.details.transcript).toContain("finished the work")
      expect(result.details.source).toBe("event-log")
      expect(result.details.snapshot).toMatchObject({
        agentId: "st_done",
        status: "completed",
        output: "all done",
      })
    }
  })

  test("#given a source-truncated transcript #when read #then the RPC-visible result reports truncation", async () => {
    const record = makeRecord({ task_id: "st_source_truncated", status: "completed" })
    const deps = depsFrom([record], () => ({
      entries: [{ kind: "assistant", text: "bounded transcript" }],
      source: "event-log",
      truncated: true,
    }))

    const result = await runTaskOutput(deps, { agentId: record.task_id, mode: "full" }, "session-parent")

    expect(result.details).toMatchObject({
      kind: "transcript",
      transcript: "assistant: bounded transcript",
      truncated: true,
    })
  })

  test("#given default mode #when read #then the host snapshot with output is returned", async () => {
    const record = makeRecord({ task_id: "st_done", status: "completed", final_response: "the answer" })
    const deps = depsFrom([record])

    const result = await runTaskOutput(deps, { agentId: "st_done" }, "session-parent")

    expect(result.details.kind).toBe("status")
    if (result.details.kind === "status") {
      expect(result.details.snapshot).toEqual({
        agentId: "st_done",
        status: "completed",
        model: "claude-sonnet-4-5",
        output: "the answer",
      })
    }
    expect(firstText(result)).toContain("the answer")
  })

  test("#given a task with a resolved model #when read #then the host snapshot uses provider/id and effort", async () => {
    const resolvedModel = {
      provider: "openai",
      model_id: "gpt-5.6-sol",
      display: "GPT-5.6 Sol",
      reasoning_effort: "high",
      variant: "xhigh",
      source: "category",
    } satisfies ResolvedModelRecord
    const record = {
      ...makeRecord({ task_id: "st_resolved", model: "openai/gpt-5.6-sol", status: "completed" }),
      resolved_model: resolvedModel,
    }
    const deps = depsFrom([record])

    const result = await runTaskOutput(deps, { agentId: "st_resolved" }, "session-parent")

    const text = firstText(result)
    expect(text).toContain("model openai/gpt-5.6-sol")
    expect(text).toContain("effort high")
    expect(result.details.kind).toBe("status")
    if (result.details.kind === "status") {
      expect(result.details.snapshot).toMatchObject({
        agentId: "st_resolved",
        status: "completed",
        model: "openai/gpt-5.6-sol",
        effort: "high",
      })
    }
  })

  test("#given a task without a resolved model #when read #then status keeps raw model fallback", async () => {
    const record = makeRecord({ task_id: "st_raw", model: "anthropic/claude-sonnet-4-5", status: "completed" })
    const deps = depsFrom([record])

    const result = await runTaskOutput(deps, { agentId: "st_raw" }, "session-parent")

    const text = firstText(result)
    expect(text).toContain("model anthropic/claude-sonnet-4-5")
    expect(text).not.toContain("effort")
  })

  test("#given a lost task #when read #then the host snapshot reports lost without throwing", async () => {
    const record = makeRecord({ task_id: "st_lost", status: "lost", pid: 4242 })
    const deps = depsFrom([record])

    const result = await runTaskOutput(deps, { agentId: "st_lost", mode: "tail" }, "session-parent")

    expect(result.details.kind).toBe("status")
    if (result.details.kind === "status") {
      expect(result.details.snapshot).toMatchObject({
        agentId: "st_lost",
        status: "lost",
      })
    }
  })

  test("#given a task owned by another session #when read #then it is not found (fail-closed scope)", async () => {
    const record = makeRecord({ task_id: "st_other", parent_session_id: "session-other" })
    const deps = depsFrom([record])

    const result = await runTaskOutput(deps, { agentId: "st_other", mode: "status" }, "session-parent")

    expect(result.details.kind).toBe("not_found")
  })

  test("#given no caller session #when read #then it fails closed as not found", async () => {
    const record = makeRecord({ task_id: "st_a", parent_session_id: "session-parent" })
    const deps = depsFrom([record])

    const result = await runTaskOutput(deps, { agentId: "st_a", mode: "status" }, undefined)

    expect(result.details.kind).toBe("not_found")
  })

  test("#given a manager whose get uses a private method #when read #then this stays bound (no brand-check error)", async () => {
    const record = makeRecord({ task_id: "st_a", parent_session_id: "session-parent" })
    // Mirrors TaskManagerImpl.get -> this.#tryLoad. An extracted `get` would throw
    // "Receiver must be an instance of class ..." here.
    class BrandCheckedManager implements OutputManager {
      #load(taskId: string): TaskRecord | undefined {
        return taskId === record.task_id ? record : undefined
      }
      get(taskId: string): TaskRecord | undefined {
        return this.#load(taskId)
      }
    }
    const deps: TaskOutputDeps = { ...depsFrom([]), manager: new BrandCheckedManager() }

    const result = await runTaskOutput(deps, { agentId: "st_a", mode: "status" }, "session-parent")

    expect(result.details.kind).toBe("status")
  })

  test("#given no agentId #when read #then invalid arguments are reported", async () => {
    const deps = depsFrom([])

    const result = await runTaskOutput(deps, { mode: "status" }, "session-parent")

    expect(result.details.kind).toBe("invalid_arguments")
  })
})
