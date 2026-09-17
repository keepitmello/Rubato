import { describe, expect, test } from "bun:test"

import type { StartResult } from "../../manager"
import { CTX, LIVE_MODEL, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  const content = result.content[0]
  return content?.type === "text" ? (content.text ?? "") : ""
}

describe("agent spawn labels", () => {
  test("#given a spawn with a summary #when the manager starts the child #then the spec carries the summary", async () => {
    let captured: unknown
    const manager = createFakeManager({
      start: async (spec): Promise<StartResult> => {
        captured = spec
        return { kind: "started", task_id: "st_00000007", status: "running", name: "task-1" }
      },
    })
    await buildTaskExecute(makeDeps(manager))(
      "call-9",
      { prompt: "inspect", model: LIVE_MODEL, summary: "Audit the waiting line" },
      undefined,
      undefined,
      CTX,
    )

    expect((captured as { task_summary?: string }).task_summary).toBe("Audit the waiting line")
  })

  test("#given a spawn with a summary #when the start is acknowledged #then the text leads with the summary", async () => {
    const manager = createFakeManager({
      start: async (): Promise<StartResult> => ({ kind: "started", task_id: "st_00000008", status: "running", name: "task-1" }),
    })

    const ack = await buildTaskExecute(makeDeps(manager))(
      "call-10",
      { prompt: "inspect", model: LIVE_MODEL, summary: "Audit the waiting line" },
      undefined,
      undefined,
      CTX,
    )

    expect(text(ack)).toContain("Started agent Audit the waiting line (st_00000008, running)")
  })
})
