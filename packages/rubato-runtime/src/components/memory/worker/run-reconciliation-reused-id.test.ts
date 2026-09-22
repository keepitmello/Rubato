import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ReflectionReservationStore,
  TranscriptJournal,
  buildIdentityPaths,
  type MemoryIdentity,
  type ReservedRun,
} from "@rubato/memory-core"

import { writeCompletionRecord } from "./completion-records"
import { reconcileReflectionRuns } from "./run-reconciliation"
import { rmEfaultTolerant } from "../teardown.test-support"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rmEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))))

// The live wedge (2026-09-23): a per-process counter re-issued `reflection-run-1` after a restart.
// The reservation under that id was made after run-1 had finished, and the queued dream carried
// `reflection-run-2`, also already finished. Every bind threw "completion record mismatch".
test("#given reservations that reuse finished run ids #when reconciled #then the stale one is released and the queued one launches under a fresh id", async () => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "reflection-reused-id-")))
  roots.push(root)
  const identity: MemoryIdentity = { id: "agent-test", safeSlug: "agent-test", paths: buildIdentityPaths(root, "agent-test") }
  const journal = new TranscriptJournal({ journalDir: join(identity.paths.transcripts, "conversation-a") })
  const ids = ["reflection-run-1", "reflection-run-2", "reflection-fresh"]
  const store = new ReflectionReservationStore({
    identity,
    config: { stepCount: 1, onCompaction: true },
    getJournal: async () => journal,
    createRunId: () => ids.shift() ?? "unexpected",
    now: () => new Date("2026-08-25T18:14:19.450Z"),
    launcherIdentity: async () => ({ pid: 97797, hostname: "fixture-host", processStart: "gone" }),
  })
  const request = { trigger: "step-count" as const, conversationIds: ["conversation-a"], snapshots: [] }
  expect((await store.tryReserve(request)).status).toBe("active")
  expect((await store.tryReserve({ ...request, trigger: "dream" as const, origin: "shutdown" as const })).status).toBe("pending")

  const completions = join(identity.paths.reflection, "completions")
  for (const runId of ["reflection-run-1", "reflection-run-2"]) {
    await writeCompletionRecord(completions, {
      schemaVersion: 1, runId, identity: identity.id, category: "quick", conversationIds: ["older"],
      trigger: "step-count", outcome: "merged", startedAt: "2026-08-18T16:00:43.432Z",
      finishedAt: "2026-08-25T17:53:18.183Z", durationMs: 1, consecutiveFailures: 0,
      delivery: { status: "consumed", sessionId: "s", consumedAt: "2026-08-25T17:53:18.494Z" },
    })
  }
  const before = await readFile(join(completions, "reflection-run-1.json"), "utf8")

  const launched: ReservedRun[] = []
  const results = await reconcileReflectionRuns({ identity, reservation: store, launch: (run) => launched.push(run) })

  expect(results).toContainEqual({ runId: "reflection-run-1", outcome: "failed" })
  expect(launched.map((run) => run.runId)).toEqual(["reflection-fresh"])
  expect((await store.readState()).active?.runId).toBe("reflection-fresh")
  expect(await readFile(join(completions, "reflection-run-1.json"), "utf8")).toBe(before)
})
