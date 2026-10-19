import { describe, expect, it } from "bun:test"

import { buildPeerMessageEnvelope, TEAM_MESSAGE_CUSTOM_TYPE, type ChildTurnFacts } from "@rubato/task"

import { taskRecord } from "./event-bridge.test-fixtures"
import { wireHarness } from "./event-bridge.test-harness"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

type Snapshot = { tasks?: Array<Record<string, unknown>> }

function lastTask(pi: ReturnType<typeof wireHarness>["pi"], taskId: string): Record<string, unknown> | undefined {
  const event = pi.rpcEvents.filter((entry) => entry.name === "rubato.task.updated").at(-1)
  return (event?.data as Snapshot | undefined)?.tasks?.find((task) => task.task_id === taskId)
}

const assistant = (text: string) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
})

function residentMember(facts: () => ChildTurnFacts) {
  // A member whose record still holds its first run: the manager never saw the turns after it.
  const member = taskRecord({
    task_id: "st_member",
    status: "completed",
    residency_state: "resident",
    final_response: "First task done.",
  })
  const harness = wireHarness("parent-session", {
    records: { [member.task_id]: member },
    residentHandles: { [member.task_id]: { readTurnFacts: async () => facts() } },
    withRpc: true,
  })
  return { member, ...harness }
}

describe("resident member turns the record never hears about", () => {
  it("#given a resting member #when it attaches #then the snapshot carries the child's latest answer and its awaited work", async () => {
    const { pi } = residentMember(() => ({
      streaming: false,
      lastAssistantText: "Second report: verified 0e4924c98.",
      awaiting: [{ id: "bash_7", description: "npm test (pi-runtime)" }],
    }))
    await pi.dispatch("session_start", {}, {})
    await settle()

    expect(lastTask(pi, "st_member")).toMatchObject({
      final_response: "First task done.",
      member_turn: {
        state: "resting",
        final_response: "Second report: verified 0e4924c98.",
        awaiting: [{ id: "bash_7", description: "npm test (pi-runtime)" }],
      },
    })
  })

  it("#given a member woken by its inbox #when the turn runs and ends #then working, then resting with that turn's final text", async () => {
    let awaiting: ChildTurnFacts["awaiting"] = []
    const { pi, emitChildEvent } = residentMember(() => ({ streaming: false, awaiting }))
    await pi.dispatch("session_start", {}, {})
    await settle()

    emitChildEvent("st_member", { type: "agent_start" })
    emitChildEvent("st_member", {
      type: "message_end",
      message: {
        role: "custom",
        customType: TEAM_MESSAGE_CUSTOM_TYPE,
        content: buildPeerMessageEnvelope({
          version: 1, messageId: "00000000-0000-4000-8000-000000000001", from: "lead", to: "verifier",
          kind: "message", body: "Recheck the integrated branch.", summary: "Recheck feat/companion", timestamp: 1,
        }),
      },
    })
    emitChildEvent("st_member", { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } })
    expect(lastTask(pi, "st_member")).toMatchObject({
      member_turn: { state: "working", assignment: { from: "lead", summary: "Recheck feat/companion" } },
      live_progress: { current_tool: expect.stringContaining("npm test") },
    })

    awaiting = [{ id: "bash_9", description: "bun test --timeout 600000" }]
    emitChildEvent("st_member", assistant("Started the long suite; I will report when it ends."))
    emitChildEvent("st_member", { type: "agent_end", willRetry: false } as never)
    await settle()

    const task = lastTask(pi, "st_member")
    expect(task).toMatchObject({
      member_turn: {
        state: "resting",
        final_response: "Started the long suite; I will report when it ends.",
        awaiting: [{ id: "bash_9", description: "bun test --timeout 600000" }],
        assignment: { from: "lead", summary: "Recheck feat/companion" },
      },
    })
    expect(task?.live_progress).toBeUndefined()

    // The job's completion wakes it: the next turn drops the wait it was resting on.
    awaiting = []
    emitChildEvent("st_member", { type: "agent_start" })
    expect((lastTask(pi, "st_member")?.member_turn as { awaiting?: unknown }).awaiting).toBeUndefined()
    emitChildEvent("st_member", assistant("Suite passed: 412 tests."))
    emitChildEvent("st_member", { type: "agent_end", willRetry: false } as never)
    await settle()
    expect(lastTask(pi, "st_member")).toMatchObject({
      member_turn: { state: "resting", final_response: "Suite passed: 412 tests.", awaiting: [] },
    })
  })

  it("#given a member mid-turn when it attaches #when the child says it streams #then it reads as working", async () => {
    const { pi } = residentMember(() => ({ streaming: true, lastAssistantText: "older text" }))
    await pi.dispatch("session_start", {}, {})
    await settle()
    expect(lastTask(pi, "st_member")).toMatchObject({ member_turn: { state: "working" } })
  })

  it("#given a completed task this process holds no handle for #then the snapshot stays the record alone", async () => {
    const done = taskRecord({ task_id: "st_done", status: "completed", final_response: "Done." })
    const { pi } = wireHarness("parent-session", { records: { [done.task_id]: done }, withRpc: true })
    await pi.dispatch("session_start", {}, {})
    await settle()
    expect(lastTask(pi, "st_done")).toMatchObject({ final_response: "Done." })
    expect(lastTask(pi, "st_done")?.member_turn).toBeUndefined()
  })
})
