// What reaches the user dream for dictation's vocabulary: the terms a project dream noticed in the
// user's words, the companion dream's inbox, and the words dictation got wrong and the person fixed.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CORRECTIONS_FILE,
  INBOX_DIR,
  cleanTerm,
  collectPending,
  consumeInputs,
  hasPending,
  normalizeObservations,
} from "./observations"
import { userStore } from "./store"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memoryRoot() {
  const root = mkdtempSync(join(tmpdir(), "rubato-vocabulary-"))
  dirs.push(root)
  const store = userStore(root)
  mkdirSync(join(store.paths.runtime, INBOX_DIR), { recursive: true })
  return { root, store }
}

const NOW = Date.parse("2026-11-20T12:00:00Z")

describe("dictation vocabulary inputs", () => {
  test("a project dream's term line becomes an observation that keeps the term", () => {
    const sessions = [{ header: { id: "s1" }, userTurns: [{ text: "INFINOX 입금 화면 0원 표시 봐 줘", at: "2026-11-20T02:00:00Z" }] }]
    const [observation] = normalizeObservations(
      '{"term": "INFINOX", "quote": "INFINOX 입금 화면", "session": "s1"}\n{"term": "<bad>"}\n',
      sessions as never,
      { project: "hash-game", runId: "r1", seenAt: "2026-11-20T03:00:00Z" },
    )
    expect(observation).toMatchObject({ term: "INFINOX", claim: 'The user says "INFINOX"', at: "2026-11-20T02:00:00Z" })
    expect(cleanTerm("  Vault\nOne ")).toBe("Vault One")
    expect(cleanTerm("x".repeat(61))).toBeUndefined()
  })

  test("the companion's inbox and new corrections are pending once, then taken", async () => {
    const { root, store } = memoryRoot()
    writeFileSync(join(store.paths.runtime, INBOX_DIR, "segno-1.json"), JSON.stringify([
      { claim: 'The user says "벳위즈"', term: "벳위즈", quote: "벳위즈 순수 수수료", project: "segno", seenAt: "2026-11-20T04:00:00Z", kind: "session" },
    ]))
    writeFileSync(join(store.paths.runtime, CORRECTIONS_FILE), [
      JSON.stringify({ at: "2026-08-01T00:00:00Z", from: "오래된", to: "기록" }),
      JSON.stringify({ at: "2026-11-20T05:00:00Z", from: "출근", to: "출금" }),
      "not json",
      JSON.stringify({ at: "2026-11-20T06:00:00Z", from: "로바토", to: "루바토" }),
      "",
    ].join("\n"))

    const pending = await collectPending(root, store, NOW)
    expect(pending.observations.map((entry) => entry.term)).toEqual(["벳위즈"])
    expect(pending.runs).toEqual(["inbox:segno-1.json"])
    // Older than the retention, so the dream never sees it.
    expect(pending.corrections.map((entry) => entry.to)).toEqual(["출금", "루바토"])
    expect(hasPending(pending)).toBe(true)

    await consumeInputs(store, pending, { runId: "u1", status: "merged", at: "2026-11-20T07:00:00Z" }, NOW)
    const after = await collectPending(root, store, NOW)
    expect(after.runs).toEqual([])
    expect(after.corrections).toEqual([])
    expect(hasPending(after)).toBe(false)

    writeFileSync(join(store.paths.runtime, CORRECTIONS_FILE), `${JSON.stringify({ at: "2026-11-20T08:00:00Z", from: "세뇨", to: "Segno" })}\n`, { flag: "a" })
    expect((await collectPending(root, store, NOW)).corrections.map((entry) => entry.to)).toEqual(["Segno"])
  })
})
