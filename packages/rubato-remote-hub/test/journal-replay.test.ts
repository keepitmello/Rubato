import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { EventJournal } from "../src/journal.js"
import { HOST_ID, SESSION_ID, summary, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

function snapshotState(revision: number) {
  return { revision, entries: [], tree: [], commands: [], capabilities: [] }
}

describe("event journal, replay, snapshot, and retention", () => {
  test("assigns canonical sequence and requires a snapshot outside retention", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    let now = Date.parse("2026-08-31T00:00:00Z")
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID, {
      maxEvents: 3,
      maxAgeMs: 60_000,
      now: () => now,
    })
    await journal.load()
    for (let index = 1; index <= 5; index++) {
      await journal.append(SESSION_ID, "session.changed", { index })
      now += 1_000
    }
    const snapshot = await journal.snapshot(summary(), snapshotState(5))

    expect(snapshot.lastSeq).toBe(5)
    expect(journal.replay(SESSION_ID, 2).type).toBe("events")
    expect(journal.replay(SESSION_ID, 1)).toMatchObject({ type: "snapshot.required", snapshot: { lastSeq: 5 } })
    expect(journal.replay(SESSION_ID, 4)).toMatchObject({ type: "events", events: [{ seq: 5 }] })
  })

  test("rebuilds sequence and snapshot inventory after a hub restart", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const journalPath = join(temporary.path, "journal")
    const snapshotPath = join(temporary.path, "snapshots")
    const first = new EventJournal(journalPath, snapshotPath, HOST_ID)
    await first.load()
    await first.append(SESSION_ID, "session.changed", { revision: 1 }, true)
    await first.snapshot(summary({ title: "Restored" }), snapshotState(1))

    const restarted = new EventJournal(journalPath, snapshotPath, HOST_ID)
    await restarted.load()
    expect(restarted.lastSeq(SESSION_ID)).toBe(1)
    expect(restarted.summaries()[0]?.title).toBe("Restored")
    expect((await restarted.append(SESSION_ID, "session.changed", { revision: 2 }, true)).seq).toBe(2)
  })

  test("retains only events inside the age window", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    let now = 100_000
    const journal = new EventJournal(join(temporary.path, "journal"), join(temporary.path, "snapshots"), HOST_ID, { maxAgeMs: 1_000, now: () => now })
    await journal.load()
    await journal.append(SESSION_ID, "session.changed", { old: true })
    now += 1_001
    await journal.append(SESSION_ID, "session.changed", { fresh: true })
    expect(journal.replay(SESSION_ID, 0).type).toBe("snapshot.required")
    expect(journal.replay(SESSION_ID, 1)).toMatchObject({ type: "events", events: [{ seq: 2 }] })
  })
})
