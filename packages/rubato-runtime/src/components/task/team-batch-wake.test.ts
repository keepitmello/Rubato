import { afterEach, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamModeConfigSchema } from "@rubato/team-core/config"
import { listUnreadMessages, sendMessage } from "@rubato/team-core/team-mailbox"
import { createRuntimeState, listActiveTeams, transitionRuntimeState } from "@rubato/team-core/team-state-store"
import { TeamSpecSchema } from "@rubato/team-core/types"
import {
  createTaskRecord,
  createTaskRecordStore,
  createTeamTask,
  resolveTeamRuntimeDirs,
  teamStorageBaseDir,
} from "@rubato/task"
import { writeMemberTaskMap } from "../../../../task/src/team/member-map"
import { IdleInjectionCoordinator } from "../../extension/idle-injection-coordinator"
import type { TaskEngine } from "./engine"
import { createLeadPollerLifecycle } from "./lead-poller-lifecycle"
import { createRuntimeTeamBatchWake } from "./team-batch-wake"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rubato-team-batch-runtime-"))
  roots.push(root)
  const stateDir = { project_dir: root }
  const config = TeamModeConfigSchema.parse({ base_dir: teamStorageBaseDir(stateDir) })
  const spec = TeamSpecSchema.parse({
    name: "batch-recovery",
    members: [
      { name: "owner", kind: "owner", model: "xai/grok-4.7", prompt: "fixture" },
      { name: "verifier", kind: "verifier", model: "xai/grok-4.7", prompt: "fixture" },
    ],
  })
  const state = await createRuntimeState(spec, "lead-session", "project", config)
  const teamRunId = state.teamRunId
  await transitionRuntimeState(teamRunId, (current) => ({ ...current, status: "active" }), config)
  const runtimeDir = resolveTeamRuntimeDirs(stateDir, teamRunId).runtimeDir
  const map = { owner: "st_00000001", verifier: "st_00000002" }
  await writeMemberTaskMap(runtimeDir, map)
  const store = createTaskRecordStore(stateDir)
  for (const [name, taskId] of Object.entries(map)) {
    store.save({
      ...createTaskRecord({
        parent_session_id: "lead-session",
        root_session_id: "lead-session",
        depth: 1,
        name: `team:${teamRunId}:${name}`,
        execution_mode: "process",
        model: "xai/grok-4.7",
        notify_on_terminal: true,
      }),
      task_id: taskId,
      status: "completed",
      final_response: `${name} result body`,
    })
    await createTeamTask({ teamRunId, config }, {
      subject: name, description: "fixture assignment", status: "completed", owner: name,
    })
  }
  const sessionFile = join(root, "lead.jsonl")
  const makeWake = (mutate = store.mutate) => {
    // Fresh store, as after a restart; no process-local record cache is the evidence.
    const freshStore = createTaskRecordStore(stateDir)
    const engine = {
      stateDir: freshStore.stateDir,
      store: { ...freshStore, mutate },
      manager: { get: (id: string) => freshStore.load(id) ?? undefined },
    } as unknown as TaskEngine
    return createRuntimeTeamBatchWake({
      engine, stateDir, config,
      sessionId: () => "lead-session",
      listTeams: () => listActiveTeams(config),
    })
  }
  const delivery = () => {
    const sent: string[] = []
    const coordinator = new IdleInjectionCoordinator((message) => {
      sent.push(message.content)
      appendFileSync(sessionFile, `${JSON.stringify({ type: "custom_message", ...message })}\n`)
    }, { scheduleFlush: () => {} })
    const lifecycle = createLeadPollerLifecycle({
      config, coordinator,
      runtime: {
        sessionId: () => "lead-session",
        sessionFile: () => sessionFile,
        parentState: () => ({ kind: "streaming" }),
      },
      listTeams: () => listActiveTeams(config),
      runtimeDir: () => runtimeDir,
      appendTaskEvent: () => {},
      pi: { sendMessage: () => { throw new Error("Expected coordinator delivery") } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scheduleInterval: () => () => {},
    })
    const poller = { pollOnce: () => lifecycle.tick(), shutdown: () => lifecycle.shutdown() }
    return { sent, coordinator, poller }
  }
  return { root, stateDir, config, store, teamRunId, runtimeDir, map, makeWake, delivery }
}

test("a crash before the deferred flush recovers exactly one body-free aggregate", async () => {
  const h = await fixture()
  expect((await h.makeWake().evaluate())[0]?.kind).toBe("delivered")
  const beforeCrash = h.delivery()
  await beforeCrash.poller.pollOnce()
  expect(beforeCrash.coordinator.pendingCount()).toBe(1)
  expect(beforeCrash.sent).toEqual([])
  beforeCrash.poller.shutdown() // Simulate losing the in-memory queue.

  expect((await h.makeWake().evaluate())[0]).toEqual({ kind: "wait", reason: "already-woken" })
  const afterCrash = h.delivery()
  await afterCrash.poller.pollOnce()
  afterCrash.coordinator.flushOnIdle()
  await afterCrash.poller.pollOnce() // Persistence acknowledgment.
  expect(afterCrash.sent).toHaveLength(1)
  expect(afterCrash.sent[0]).toContain("Team batch complete")
  expect(afterCrash.sent[0]).not.toContain("owner result body")
  const paths = [...afterCrash.sent[0]!.matchAll(/^result (.+)$/gm)].map((match) => match[1]!)
  expect(paths).toHaveLength(2)
  expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(["owner result body", "verifier result body"])
  afterCrash.poller.shutdown()
  const anotherRestart = h.delivery()
  await anotherRestart.poller.pollOnce()
  anotherRestart.coordinator.flushOnIdle()
  expect(anotherRestart.sent).toEqual([])
})

test("a crash after persistence but before acknowledgment cannot repeat the wake", async () => {
  const h = await fixture()
  await h.makeWake().evaluate()
  const first = h.delivery()
  await first.poller.pollOnce()
  first.coordinator.flushOnIdle() // JSONL written, reservation not acknowledged yet.
  expect(first.sent).toHaveLength(1)
  first.poller.shutdown()
  const restarted = h.delivery()
  await restarted.poller.pollOnce()
  restarted.coordinator.flushOnIdle()
  expect(restarted.sent).toEqual([])
})

test("a crash between durable publication and record stamping reuses the batch message id", async () => {
  const h = await fixture()
  const failed = h.makeWake(() => { throw new Error("crash before mark") })
  expect((await failed.evaluate())[0]?.kind).toBe("failed")
  const first = await listUnreadMessages(h.teamRunId, "lead", h.config)
  expect(first).toHaveLength(1)
  expect((await h.makeWake().evaluate())[0]?.kind).toBe("delivered")
  expect(await listUnreadMessages(h.teamRunId, "lead", h.config)).toEqual(first)

  const delivery = h.delivery()
  await delivery.poller.pollOnce()
  delivery.coordinator.flushOnIdle()
  await delivery.poller.pollOnce()
  // Even if a record marker is lost, the consumed mailbox identity prevents a second wake.
  for (const id of Object.values(h.map)) {
    h.store.mutate(id, (record) => ({
      ...record, notification: { ...record.notification, aggregate_woken_epoch: -1 },
    }))
  }
  await h.makeWake().evaluate()
  expect(await listUnreadMessages(h.teamRunId, "lead", h.config)).toEqual([])
  expect(delivery.sent).toHaveLength(1)
})

test("a resumed batch gets new result paths without changing the first run's files", async () => {
  const h = await fixture()
  await h.makeWake().evaluate()
  const first = (await listUnreadMessages(h.teamRunId, "lead", h.config))[0]!
  const firstPaths = [...first.body.matchAll(/^result (.+)$/gm)].map((match) => match[1]!)
  for (const id of Object.values(h.map)) {
    h.store.mutate(id, (record) => ({
      ...record,
      final_response: "resumed result",
      notification: { ...record.notification, run_epoch: record.notification.run_epoch + 1 },
    }))
  }
  await h.makeWake().evaluate()
  const messages = await listUnreadMessages(h.teamRunId, "lead", h.config)
  expect(messages).toHaveLength(2)
  expect(new Set(messages.map((message) => message.messageId)).size).toBe(2)
  expect(firstPaths.map((path) => readFileSync(path, "utf8"))).toEqual(["owner result body", "verifier result body"])
})

test("an unmapped roster member cannot disappear from all-members completion", async () => {
  const h = await fixture()
  await writeMemberTaskMap(h.runtimeDir, { owner: h.map.owner })
  expect((await h.makeWake().evaluate())[0]).toEqual({ kind: "wait", reason: "member-unmapped:verifier" })
  expect(await listUnreadMessages(h.teamRunId, "lead", h.config)).toEqual([])
})

test("undelivered peer work prevents the aggregate", async () => {
  const h = await fixture()
  await sendMessage({
    version: 1, messageId: crypto.randomUUID(), from: "owner", to: "verifier",
    kind: "message", body: "please recheck", timestamp: Date.now(),
  }, h.teamRunId, h.config, { isLead: false, activeMembers: ["owner", "verifier"] })
  expect((await h.makeWake().evaluate())[0]).toEqual({ kind: "wait", reason: "member-has-queued-work:verifier" })
  expect(await listUnreadMessages(h.teamRunId, "lead", h.config)).toEqual([])
})
