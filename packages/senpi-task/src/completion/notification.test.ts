import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { buildCompletionDetails, buildCompletionMessage } from "./notification"
import type { TaskRecord } from "../state"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "senpi-task-completion-"))
  tempDirs.push(dir)
  return dir
}

function completedRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "st_deadbeef",
    name: "summarize-logs",
    parent_session_id: "parent-session",
    root_session_id: "root-session",
    depth: 1,
    execution_mode: "in-process",
    model: "gpt-5.2",
    status: "completed",
    residency_state: "resident",
    created_at: "2026-07-06T01:00:00.000Z",
    updated_at: "2026-07-06T01:00:03.000Z",
    final_response: "the final answer",
    notify_on_terminal: false,
    notification: { run_epoch: 0, notified_epoch: -1 },
    ...overrides,
  }
}

describe("buildCompletionDetails", () => {
  test("#given completed record #when details built #then core facts, full result, and duration are populated", () => {
    // given
    const record = completedRecord()

    // when
    const details = buildCompletionDetails(record)

    // then
    expect(details.agentId).toBe("st_deadbeef")
    expect(details.name).toBe("summarize-logs")
    expect(details.status).toBe("completed")
    expect(details.duration_ms).toBe(3000)
    expect(details.final_response).toBe("the final answer")
    expect(details.continuation_hint).toContain("st_deadbeef")
  })

  test("#given a result longer than the former 700-char cap #when details built #then the full result is included", () => {
    // given
    const result = "x".repeat(2_000)

    // when
    const details = buildCompletionDetails(completedRecord({ final_response: result }))

    // then
    expect(details.final_response).toBe(result)
  })

  test("#given a result beyond transport capacity #when details built #then its full text is spilled to a local file", () => {
    // given
    const stateDir = tempStateDir()
    const result = "x".repeat(32_001)

    // when
    const details = buildCompletionDetails(completedRecord({ final_response: result }), { stateDir })

    // then
    expect(details.final_response_file).toStartWith("local://")
    expect(details.final_response.length).toBeLessThan(result.length)
    const spillPath = details.final_response_file?.slice("local://".length) ?? ""
    expect(existsSync(spillPath)).toBe(true)
    expect(readFileSync(spillPath, "utf8")).toBe(result)
  })

  test("#given resident completed record #when details built #then continuation hint names AgentSend but never AgentOutput", () => {
    // given
    const record = completedRecord()

    // when
    const details = buildCompletionDetails(record)

    // then
    expect(details.continuation_hint).toContain("AgentSend")
    expect(details.continuation_hint).not.toContain("AgentOutput")
    expect(details.continuation_hint).not.toContain("task_send")
    expect(details.continuation_hint).not.toContain("task_output")
  })

  test("#given resident completed record #when details built #then AgentSend hint uses agentId and message params", () => {
    // given
    const record = completedRecord()

    // when
    const details = buildCompletionDetails(record)

    // then
    expect(details.continuation_hint).toContain("AgentSend({ agentId:")
    expect(details.continuation_hint).toContain("message:")
    expect(details.continuation_hint).not.toContain("AgentSend({ task_id:")
    expect(details.continuation_hint).not.toContain("task_send")
    expect(details.continuation_hint).not.toContain("prompt:")
  })

  test("#given error record #when details built #then error message feeds the full result", () => {
    // given
    const record = completedRecord({
      status: "error",
      final_response: undefined,
      error_message: "child crashed",
    })

    // when
    const details = buildCompletionDetails(record)

    // then
    expect(details.status).toBe("error")
    expect(details.final_response).toBe("child crashed")
  })

  test("#given tokens provided #when details built #then tokens are attached", () => {
    // given
    const record = completedRecord()

    // when
    const details = buildCompletionDetails(record, { tokens: 1234 })

    // then
    expect(details.tokens).toBe(1234)
  })
})

describe("buildCompletionMessage", () => {
  test("#given a complete result #when notification built #then the ping carries status without inlining the body", () => {
    // given
    const fullResult = "child final text ".repeat(100)
    const details = buildCompletionDetails(completedRecord({ final_response: fullResult }))

    // when
    const message = buildCompletionMessage([details])

    // then
    expect(message.customType).toBe("senpi-task.completion")
    expect(message.details).toEqual([details])
    expect(message.details[0]?.final_response).toBe(fullResult)
    expect(message.content).toBe("completed summarize-logs st_deadbeef")
    expect(message.content).not.toContain(fullResult)
    expect(message.content).not.toContain("result:")
    expect(message.content).not.toContain("AgentSend")
    expect(message.content).not.toContain("AgentOutput")
    expect(message.content).not.toContain("duration:")
    expect(message.content).not.toContain("<task-notification>")
  })

  test("#given a spilled result #when notification built #then the ping still omits the blob and the file stays on details", () => {
    // given
    const details = buildCompletionDetails(
      completedRecord({ final_response: "x".repeat(32_001) }),
      { stateDir: tempStateDir() },
    )

    // when
    const message = buildCompletionMessage([details])

    // then
    expect(details.final_response_file).toStartWith("local://")
    expect(message.content).not.toContain("x".repeat(100))
    expect(message.content).not.toContain(details.final_response_file ?? "local://")
  })

  test("#given two details #when message built #then both completions appear in one content block", () => {
    // given
    const first = buildCompletionDetails(completedRecord({ task_id: "st_aaaa", name: "one" }))
    const second = buildCompletionDetails(completedRecord({ task_id: "st_bbbb", name: "two" }))

    // when
    const message = buildCompletionMessage([first, second])

    // then
    expect(message.details).toHaveLength(2)
    expect(message.content).toBe("completed one st_aaaa\ncompleted two st_bbbb")
    expect(message.content).not.toContain("<task-notification>")
  })
})

describe("completion run stats", () => {
  test("#given a record with run stats #when details are built #then run stats and token fallback are attached", () => {
    // given
    const record = completedRecord({
      run_stats: {
        runtime_ms: 3_000,
        turns: 2,
        tool_calls: 4,
        output_tokens: 500,
        total_tokens: 1_800,
        generation_ms: 2_000,
        tokens_per_second: 250,
      },
    })

    // when
    const details = buildCompletionDetails(record)
    const message = buildCompletionMessage([details])

    // then
    expect(details.run_stats?.tokens_per_second).toBe(250)
    expect(details.tokens).toBe(1_800)
    expect(message.content).toBe("completed summarize-logs st_deadbeef")
    expect(message.content).not.toContain("tps:")
    expect(message.content).not.toContain("tools:")
  })

  test("#given explicit tokens #when details are built #then the explicit value wins over run stats", () => {
    // given
    const record = completedRecord({
      run_stats: { runtime_ms: 3_000, turns: 1, tool_calls: 0, total_tokens: 1_800 },
    })

    // when
    const details = buildCompletionDetails(record, { tokens: 42 })

    // then
    expect(details.tokens).toBe(42)
  })
})
