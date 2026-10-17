import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sessionTailNeedsContinuation } from "./interrupted-turn"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function session(lines: readonly (object | string)[]): string {
  const root = mkdtempSync(join(tmpdir(), "rubato-interrupted-turn-"))
  roots.push(root)
  const file = join(root, "child.jsonl")
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n")
  return file
}
const message = (role: string, extra: object = {}) => ({ type: "message", message: { role, content: [], ...extra } })
const toolCall = message("assistant", { stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "bash" }] })

describe("sessionTailNeedsContinuation", () => {
  test("#given a turn stopped at its tool results #then it continues", async () => {
    expect(await sessionTailNeedsContinuation(session([message("user"), toolCall, message("toolResult")]))).toBe(true)
  })

  test("#given shutdown bookkeeping after the tool results (a drained restart) #then it still continues", async () => {
    const file = session([message("user"), toolCall, message("toolResult"),
      { type: "custom", customType: "rubato.context-mode.v1", data: {} }, { type: "model_change", provider: "x", modelId: "y" }])
    expect(await sessionTailNeedsContinuation(file)).toBe(true)
  })

  test("#given a finished reply followed by bookkeeping #then nothing continues", async () => {
    const file = session([message("user"), message("assistant", { stopReason: "stop", content: [{ type: "text", text: "done" }] }),
      { type: "custom", customType: "rubato.context-mode.v1", data: {} }])
    expect(await sessionTailNeedsContinuation(file)).toBe(false)
  })

  test("#given an unanswered model-visible custom message #then it continues", async () => {
    expect(await sessionTailNeedsContinuation(session([message("user"), message("assistant", { stopReason: "stop" }),
      { type: "custom_message", customType: "rubato.task.completion", content: "child done" }]))).toBe(true)
  })

  test("#given a malformed final record #then it does not guess from an earlier entry", async () => {
    expect(await sessionTailNeedsContinuation(session([message("user"), "{\"type\":\"custom\",\"trunc"]))).toBe(false)
  })

  test("#given bookkeeping larger than the first tail window #then the window grows to the conversation", async () => {
    const bulky = { type: "custom", customType: "rubato.big", data: "x".repeat(70 * 1024) }
    expect(await sessionTailNeedsContinuation(session([message("user"), toolCall, message("toolResult"), bulky, bulky]))).toBe(true)
  })
})
