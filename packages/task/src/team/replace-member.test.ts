import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { listUnreadMessages, reserveMessageForDelivery } from "@rubato/team-core/team-mailbox"
import { loadRuntimeState, transitionRuntimeState } from "@rubato/team-core/team-state-store"

import { readMemberTaskMap } from "./member-map"
import { createMemberSelfPoller } from "./member-extension/self-poller"
import { runMemberTaskSend } from "./member-extension/tools"
import { createTeamMemberRespawnLaunchResolver } from "./member-respawn"
import { normalizeSenpiTeamSpec } from "./normalize"
import { replaceTeamMember, type ReplaceTeamMemberDeps } from "./replace-member"
import { createTeam, deleteTeam } from "./runtime"
import { toTeamCoreConfig } from "./runtime-config"
import { resolveTeamRuntimeDirs, teamStorageBaseDir, withTeamRuntimeMutation } from "./storage"
import { claimTeamTask, createTeamTask, getTeamTask } from "./tasks"
import {
  FakeDestruction, FakeTeamManager, cleanupTeamRuntimeTmp, stateDirConfig,
  taskSettings, tempProjectDir,
} from "./__fixtures__/runtime-fakes"

afterEach(cleanupTeamRuntimeTmp)

async function harness(manager = new FakeTeamManager()) {
  const root = tempProjectDir()
  const stateDir = stateDirConfig(root)
  const deps: ReplaceTeamMemberDeps = {
    manager, stateDir, destruction: new FakeDestruction(), taskSettings: taskSettings(),
    leadSessionId: "lead-session", spawnDepth: 1,
    memberPorts: { isModelAvailable: (model) => model === "rubato-mock/mock-1" },
    memberExtension: { entryPath: "/tmp/member-extension.mjs" },
  }
  const created = await createTeam(normalizeSenpiTeamSpec({
    members: [
      { name: "owner", kind: "owner", model: "rubato-mock/mock-1", prompt: "Implement." },
      { name: "verifier", kind: "verifier", model: "rubato-mock/mock-1", prompt: "Verify.", worktreePath: join(root, "review-worktree") },
    ],
  }, "recovery"), "project", deps)
  const teamRunId = created.runtimeState.teamRunId
  const expectedTaskId = created.memberTaskIds.verifier!
  const config = toTeamCoreConfig(deps.taskSettings, teamStorageBaseDir(stateDir))
  const { runtimeDir } = resolveTeamRuntimeDirs(stateDir, teamRunId)
  const input = {
    teamRunId, member: "verifier", expectedTaskId, model: "rubato-mock/mock-1",
    prompt: "Review evidence.md revision B. Revision A passed; owner requests recheck of correction C.",
  }
  return { root, deps, manager, created, teamRunId, config, runtimeDir, input }
}

type Harness = Awaited<ReturnType<typeof harness>>

function endpoint(h: Harness, name: string, taskId: string) {
  const sessionDir = join(h.root, "sessions", taskId)
  mkdirSync(sessionDir, { recursive: true })
  const injected: string[] = []
  const isCurrentMember = async () => (await readMemberTaskMap(h.runtimeDir))[name] === taskId
  const poller = createMemberSelfPoller({
    teamRunId: h.teamRunId, memberName: name, config: h.config, sessionDir, isCurrentMember,
    inject(content, messageId) {
      injected.push(content)
      appendFileSync(join(sessionDir, "session.jsonl"), JSON.stringify({
        type: "custom_message", customType: "senpi-task:team-message", content, details: { messageId },
      }) + "\n")
    },
  })
  return {
    poller, injected,
    send: (to: string, message: string) => runMemberTaskSend({
      teamRunId: h.teamRunId, memberName: name, taskId, config: h.config,
      members: ["owner", "verifier"], isCurrentMember,
    }, { to, message }),
  }
}

describe("same-team member recovery", () => {
  test("failed verifier keeps its mailbox and board owner; correction/refutation/recheck stays peer-to-peer", async () => {
    const h = await harness()
    const ctx = { teamRunId: h.teamRunId, config: h.config }
    const board = await createTeamTask(ctx, { subject: "Verify C", description: "evidence.md", status: "pending" })
    await claimTeamTask(ctx, board.id, "verifier")
    const owner = endpoint(h, "owner", h.created.memberTaskIds.owner!)
    const oldVerifier = endpoint(h, "verifier", h.input.expectedTaskId)
    h.manager.setStatus(h.input.expectedTaskId, "error")
    const sent = await owner.send("verifier", "Correction C is ready for recheck.")
    // Simulate a crash reservation whose envelope never reached the failed session.
    await reserveMessageForDelivery(h.teamRunId, "verifier", sent.details.message_id, h.config)

    const replaced = await replaceTeamMember(h.input, h.deps)
    const verifier = endpoint(h, "verifier", replaced.member.taskId)
    await oldVerifier.poller.pollOnce()
    expect(oldVerifier.injected).toEqual([])
    await expect(oldVerifier.send("owner", "stale verdict")).rejects.toThrow("not the team's active member")
    await verifier.poller.pollOnce()
    await verifier.poller.checkPendingAcks()
    expect(verifier.injected).toHaveLength(1)
    expect(verifier.injected[0]).toContain("Correction C")
    await verifier.send("owner", "FAIL: C still violates the accepted criterion; reproduce with fixture C.")
    await owner.poller.pollOnce()
    await owner.poller.checkPendingAcks()
    expect(owner.injected[0]).toContain("FAIL: C")
    await owner.send("verifier", "Fixed C in revision D; recheck the same fixture.")
    await verifier.poller.pollOnce()
    await verifier.poller.checkPendingAcks()
    expect(verifier.injected[1]).toContain("revision D")
    expect(await listUnreadMessages(h.teamRunId, "lead", h.config)).toEqual([])
    expect((await getTeamTask(ctx, board.id)).owner).toBe("verifier")
    expect((await readMemberTaskMap(h.runtimeDir)).owner).toBe(h.created.memberTaskIds.owner)
    expect(h.manager.get(h.input.expectedTaskId)?.status).toBe("error")
    const launch = h.manager.started.at(-1)!
    expect(launch.name).toMatch(new RegExp(`^team:${h.teamRunId}:verifier@[0-9a-f-]{36}$`))
    expect(launch.memberEnv?.RUBATO_PI_ROLE).toBe("verifier")
    expect(launch.cwd).toBe(join(h.root, "review-worktree"))
    expect(JSON.parse(launch.memberEnv!.RUBATO_TASK_TEAM_CONFIG!).members).toEqual(["owner", "verifier"])
    expect(launch.prompt).toContain("Revision A passed")

    const resolver = createTeamMemberRespawnLaunchResolver({ ...h.deps, memberExtension: h.deps.memberExtension! })
    expect((await resolver(h.manager.get(replaced.member.taskId)!))?.memberEnv?.RUBATO_TASK_MEMBER_TASK_ID)
      .toBe(replaced.member.taskId)
    await expect(resolver(h.manager.get(h.input.expectedTaskId)!)).rejects.toThrow("task_mapping_mismatch")
    await deleteTeam(h.teamRunId, h.deps)
    expect(h.manager.cancelled.map((row) => row.taskId)).toContain(replaced.member.taskId)
  })

  test.each([
    ["running", "resident"], ["completed", "resident"], ["completed", "rpc_detached"],
    ["completed", "persisted_only"], ["interrupted", "resident"],
    ["cancelled", "disposed"], ["pending", "resident"],
  ] as const)("does not replace a continuable/stopped %s/%s member", async (status, residency) => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, status)
    h.manager.setResidency(h.input.expectedTaskId, residency)
    await expect(replaceTeamMember(h.input, h.deps)).rejects.toMatchObject({ code: "member_continuable" })
    expect(h.manager.started).toHaveLength(2)
    expect((h.deps.destruction as FakeDestruction).calls).toEqual([])
  })

  test.each(["error", "lost", "disposed", "evicted"] as const)("recovers unavailable %s execution", async (state) => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, state === "error" || state === "lost" ? state : "completed")
    if (state === "disposed" || state === "evicted") h.manager.setResidency(h.input.expectedTaskId, state)
    const result = await replaceTeamMember(h.input, h.deps)
    expect(result.previousTaskId).toBe(h.input.expectedTaskId)
    expect((await readMemberTaskMap(h.runtimeDir)).verifier).toBe(result.member.taskId)
  })

  test("invalid route, empty handoff and foreign lead fail before teardown", async () => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, "error")
    await expect(replaceTeamMember({ ...h.input, model: "missing/model" }, h.deps)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" })
    await expect(replaceTeamMember({ ...h.input, prompt: " " }, h.deps)).rejects.toMatchObject({ code: "missing_handoff" })
    await expect(replaceTeamMember(h.input, { ...h.deps, leadSessionId: "other-lead" })).rejects.toMatchObject({ code: "not_owner" })
    expect((h.deps.destruction as FakeDestruction).calls).toEqual([])
  })

  test("concurrent retries cannot replace a newer attempt", async () => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, "error")
    const outcomes = await Promise.allSettled([
      replaceTeamMember(h.input, h.deps), replaceTeamMember(h.input, h.deps),
    ])
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      status: "rejected", reason: { code: "stale_member" },
    })
    expect(h.manager.started).toHaveLength(3)
  })

  test("spawn failure retains old mapping and unread correction", async () => {
    const h = await harness(new FakeTeamManager({
      behaviors: [{ kind: "ok" }, { kind: "ok" }, { kind: "throw", message: "spawn unavailable" }],
    }))
    h.manager.setStatus(h.input.expectedTaskId, "error")
    await endpoint(h, "owner", h.created.memberTaskIds.owner!).send("verifier", "unread correction")
    await expect(replaceTeamMember(h.input, h.deps)).rejects.toThrow("spawn unavailable")
    expect((await readMemberTaskMap(h.runtimeDir)).verifier).toBe(h.input.expectedTaskId)
    expect(await listUnreadMessages(h.teamRunId, "verifier", h.config)).toHaveLength(1)
  })

  test("map publication failure cannot consume mail and restores metadata before explicit retry", async () => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, "error")
    const before = await loadRuntimeState(h.teamRunId, h.config)
    await endpoint(h, "owner", h.created.memberTaskIds.owner!).send("verifier", "unread correction")
    await expect(replaceTeamMember(h.input, {
      ...h.deps,
      async writeMemberMap(_dir, map) {
        const unpublished = endpoint(h, "verifier", map.verifier!)
        await unpublished.poller.pollOnce()
        expect(unpublished.injected).toEqual([])
        throw new Error("disk unavailable")
      },
    })).rejects.toThrow("disk unavailable")
    expect((await loadRuntimeState(h.teamRunId, h.config)).members).toEqual(before.members)
    expect((await readMemberTaskMap(h.runtimeDir)).verifier).toBe(h.input.expectedTaskId)
    expect(h.manager.cancelled).toHaveLength(1)
    expect(await listUnreadMessages(h.teamRunId, "verifier", h.config)).toHaveLength(1)
    const result = await replaceTeamMember(h.input, h.deps)
    const replacement = endpoint(h, "verifier", result.member.taskId)
    await replacement.poller.pollOnce()
    expect(replacement.injected[0]).toContain("unread correction")
  })

  test("shutdown and deletion share the replacement mutation boundary", async () => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, "error")
    await withTeamRuntimeMutation(h.deps.stateDir, h.teamRunId, () => transitionRuntimeState(h.teamRunId, (state) => ({
      ...state, shutdownRequests: [{ memberId: "verifier", requesterName: "lead", requestedAt: 1 }],
    }), h.config))
    await expect(replaceTeamMember(h.input, h.deps)).rejects.toMatchObject({ code: "shutdown_pending" })
    await deleteTeam(h.teamRunId, h.deps)
    await expect(replaceTeamMember(h.input, h.deps)).rejects.toThrow()
    expect(h.manager.started).toHaveLength(2)
  })

  test("approved shutdown stays closed even when the old member status is errored", async () => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, "error")
    await transitionRuntimeState(h.teamRunId, (state) => ({
      ...state,
      members: state.members.map((member) => member.name === "verifier" ? { ...member, status: "errored" } : member),
      shutdownRequests: [{ memberId: "verifier", requesterName: "lead", requestedAt: 1, approvedAt: 2 }],
    }), h.config)
    await expect(replaceTeamMember(h.input, h.deps)).rejects.toMatchObject({ code: "shutdown_approved" })
    expect(h.manager.started).toHaveLength(2)
  })

  test("a state change before activation discards the unactivated attempt without publishing its address", async () => {
    const h = await harness()
    h.manager.setStatus(h.input.expectedTaskId, "error")
    await expect(replaceTeamMember(h.input, {
      ...h.deps,
      manager: {
        start: async (spec) => {
          const result = await h.manager.start(spec)
          await transitionRuntimeState(h.teamRunId, (state) => ({ ...state, status: "shutdown_requested" }), h.config)
          return result
        },
        get: (id) => h.manager.get(id),
        getResidentHandle: (id) => h.manager.getResidentHandle(id),
        cancelTask: (id, reason) => h.manager.cancelTask(id, reason),
      },
    })).rejects.toMatchObject({ code: "team_changed" })
    expect((await readMemberTaskMap(h.runtimeDir)).verifier).toBe(h.input.expectedTaskId)
    expect(h.manager.cancelled).toHaveLength(1)
    expect((await loadRuntimeState(h.teamRunId, h.config)).status).toBe("shutdown_requested")
  })

  test("deleting an unknown run still succeeds without a preexisting state root", async () => {
    const stateDir = stateDirConfig(tempProjectDir())
    const result = await deleteTeam("00000000-0000-4000-8000-000000000000", {
      stateDir, taskSettings: taskSettings(), manager: new FakeTeamManager(), destruction: new FakeDestruction(),
    })
    expect(result.cancelledTaskIds).toEqual([])
  })
})
