import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { loadRuntimeState, transitionRuntimeState } from "@rubato/team-core/team-state-store"

import { addTeamMember, type AddTeamMemberDeps } from "./add-member"
import { readMemberTaskMap } from "./member-map"
import { createMemberSelfPoller } from "./member-extension/self-poller"
import { runMemberTaskSend } from "./member-extension/tools"
import { createTeamMemberRespawnLaunchResolver } from "./member-respawn"
import { normalizeSenpiTeamSpec } from "./normalize"
import { replaceTeamMember } from "./replace-member"
import { createTeam, deleteTeam } from "./runtime"
import { refreshTeamMemberStatuses } from "./member-projection"
import { approveShutdown, requestShutdown } from "./shutdown"
import { toTeamCoreConfig } from "./runtime-config"
import { liveMemberNames } from "./shutdown-helpers"
import { resolveTeamRuntimeDirs, teamStorageBaseDir } from "./storage"
import {
  FakeDestruction, FakeTeamManager, cleanupTeamRuntimeTmp, stateDirConfig,
  taskSettings, tempProjectDir,
} from "./__fixtures__/runtime-fakes"

afterEach(cleanupTeamRuntimeTmp)

const MODEL = "rubato-mock/mock-1"

async function harness(options: { maxMembers?: number } = {}) {
  const root = tempProjectDir()
  const stateDir = stateDirConfig(root)
  const manager = new FakeTeamManager()
  const deps: AddTeamMemberDeps = {
    manager, stateDir, destruction: new FakeDestruction(),
    taskSettings: taskSettings(options.maxMembers !== undefined ? { max_members: options.maxMembers } : {}),
    leadSessionId: "lead-session", spawnDepth: 1,
    memberPorts: { isModelAvailable: (model) => model === MODEL },
    memberExtension: { entryPath: "/tmp/member-extension.mjs" },
  }
  const created = await createTeam(normalizeSenpiTeamSpec({
    members: [{ name: "owner", kind: "owner", model: MODEL, prompt: "Implement." }],
  }, "growing"), "project", deps)
  const teamRunId = created.runtimeState.teamRunId
  const config = toTeamCoreConfig(deps.taskSettings, teamStorageBaseDir(stateDir))
  const { runtimeDir } = resolveTeamRuntimeDirs(stateDir, teamRunId)
  const input = { teamRunId, name: "verifier", kind: "verifier" as const, model: MODEL, prompt: "Verify revision B against intent-7." }
  return { root, deps, manager, created, teamRunId, config, runtimeDir, input }
}

type Harness = Awaited<ReturnType<typeof harness>>

// A member process as the extension wires it: the spawn-time roster plus the live roster read.
function endpoint(h: Harness, name: string, taskId: string, spawnRoster: readonly string[]) {
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
      members: spawnRoster, isCurrentMember,
      currentMembers: async () => liveMemberNames(await loadRuntimeState(h.teamRunId, h.config)),
    }, { to, message }),
  }
}

describe("adding a member to a running team", () => {
  test("the new member joins the same team and peers started earlier can reach it", async () => {
    const h = await harness()
    const added = await addTeamMember(h.input, h.deps)

    const state = await loadRuntimeState(h.teamRunId, h.config)
    expect(state.members.map((member) => [member.name, member.kind])).toEqual([["owner", "owner"], ["verifier", "verifier"]])
    expect(await readMemberTaskMap(h.runtimeDir)).toEqual({ owner: h.created.memberTaskIds.owner, verifier: added.member.taskId })
    const launch = h.manager.started.at(-1)!
    expect(launch.name).toBe(`team:${h.teamRunId}:verifier`)
    expect(launch.memberEnv?.RUBATO_PI_ROLE).toBe("verifier")
    expect(JSON.parse(launch.memberEnv!.RUBATO_TASK_TEAM_CONFIG!).members).toEqual(["owner", "verifier"])
    expect(launch.prompt).toContain("Peers already working: owner.")
    expect(launch.prompt).toContain("intent-7")

    // The owner was spawned when the roster was only itself.
    const owner = endpoint(h, "owner", h.created.memberTaskIds.owner!, ["owner"])
    const verifier = endpoint(h, "verifier", added.member.taskId, ["owner", "verifier"])
    await owner.send("verifier", "Revision B is ready.")
    await verifier.poller.pollOnce()
    expect(verifier.injected[0]).toContain("Revision B is ready.")
    await verifier.send("owner", "FAIL: fixture C.")
    await owner.poller.pollOnce()
    expect(owner.injected[0]).toContain("FAIL: fixture C.")

    const resolver = createTeamMemberRespawnLaunchResolver({ ...h.deps, memberExtension: h.deps.memberExtension! })
    expect((await resolver(h.manager.get(added.member.taskId)!))?.memberEnv?.RUBATO_TASK_MEMBER).toBe(`${h.teamRunId}::verifier`)
    await deleteTeam(h.teamRunId, h.deps)
    expect(h.manager.cancelled.map((row) => row.taskId)).toContain(added.member.taskId)
  })

  test("a removed member is no longer a recipient and its slot frees, but its name stays taken", async () => {
    const h = await harness({ maxMembers: 2 })
    await addTeamMember(h.input, h.deps)
    await expect(addTeamMember({ ...h.input, name: "extra" }, h.deps)).rejects.toMatchObject({ code: "bounds_exceeded" })
    await transitionRuntimeState(h.teamRunId, (state) => ({
      ...state,
      members: state.members.map((member) => member.name === "verifier" ? { ...member, status: "shutdown_approved" } : member),
    }), h.config)

    const owner = endpoint(h, "owner", h.created.memberTaskIds.owner!, ["owner", "verifier"])
    await expect(owner.send("verifier", "still there?")).rejects.toThrow("Unknown team recipient: verifier")
    await expect(addTeamMember(h.input, h.deps)).rejects.toMatchObject({ code: "name_taken" })
    const extra = await addTeamMember({ ...h.input, name: "extra" }, h.deps)
    expect(extra.member.name).toBe("extra")
  })

  test("refusals start nothing", async () => {
    const h = await harness()
    const before = h.manager.started.length
    await expect(addTeamMember({ ...h.input, name: "owner" }, h.deps)).rejects.toMatchObject({ code: "name_taken" })
    await expect(addTeamMember({ ...h.input, model: "missing/model" }, h.deps)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" })
    await expect(addTeamMember(h.input, { ...h.deps, leadSessionId: "other" })).rejects.toMatchObject({ code: "not_owner" })
    await expect(addTeamMember({ ...h.input, prompt: "  " }, h.deps)).rejects.toMatchObject({ code: "missing_brief" })
    expect(h.manager.started).toHaveLength(before)
    expect((await loadRuntimeState(h.teamRunId, h.config)).members.map((member) => member.name)).toEqual(["owner"])
  })

  test("a failed map write rolls the new member back out of the team", async () => {
    const h = await harness()
    await expect(addTeamMember(h.input, { ...h.deps, writeMemberMap: async () => { throw new Error("disk full") } }))
      .rejects.toThrow("disk full")
    expect((await loadRuntimeState(h.teamRunId, h.config)).members.map((member) => member.name)).toEqual(["owner"])
    expect(await readMemberTaskMap(h.runtimeDir)).toEqual({ owner: h.created.memberTaskIds.owner })
    expect(h.manager.cancelled).toHaveLength(1)
    expect(h.manager.cancelled[0]?.taskId).not.toBe(h.created.memberTaskIds.owner)
    expect((h.deps.destruction as FakeDestruction).calls.map((call) => call.taskId)).toEqual([h.manager.cancelled[0]!.taskId])
  })

  test("a member removed after it finished stays removed through a status refresh", async () => {
    const h = await harness({ maxMembers: 2 })
    const added = await addTeamMember(h.input, h.deps)
    h.manager.setStatus(added.member.taskId, "completed")
    await refreshTeamMemberStatuses(h.teamRunId, { manager: h.manager, config: h.config, runtimeDir: h.runtimeDir })
    const shutdownDeps = { config: h.config, sendMessage: async () => {}, cancelMemberTask: async () => {} }
    await requestShutdown(h.teamRunId, "verifier", shutdownDeps)
    const approved = await approveShutdown(h.teamRunId, "verifier", shutdownDeps)
    // Approval keeps a finished member's status; removal is the approved request.
    expect(approved.members.find((member) => member.name === "verifier")?.status).toBe("completed")
    const refreshed = await refreshTeamMemberStatuses(h.teamRunId, { manager: h.manager, config: h.config, runtimeDir: h.runtimeDir })
    expect(liveMemberNames(refreshed)).toEqual(["owner"])

    const owner = endpoint(h, "owner", h.created.memberTaskIds.owner!, ["owner", "verifier"])
    await expect(owner.send("verifier", "still there?")).rejects.toThrow("Unknown team recipient: verifier")
    const resolver = createTeamMemberRespawnLaunchResolver({ ...h.deps, memberExtension: h.deps.memberExtension! })
    await expect(resolver(h.manager.get(added.member.taskId)!)).rejects.toThrow("member_missing")
    expect((await addTeamMember({ ...h.input, name: "successor" }, h.deps)).member.name).toBe("successor")
  })

  test("a loose name is normalized to one the member process carries; the lead's name is refused", async () => {
    const h = await harness()
    const before = h.manager.started.length
    await expect(addTeamMember({ ...h.input, name: "lead" }, h.deps)).rejects.toMatchObject({ code: "RESERVED_LEAD_MEMBER" })
    expect(h.manager.started).toHaveLength(before)
    const added = await addTeamMember({ ...h.input, name: "Second Reviewer" }, h.deps)
    expect(added.member.name).toBe("second-reviewer")
    expect(h.manager.started.at(-1)?.memberEnv?.RUBATO_TASK_MEMBER).toBe(`${h.teamRunId}::second-reviewer`)
    await expect(addTeamMember({ ...h.input, name: "SECOND reviewer" }, h.deps)).rejects.toMatchObject({ code: "name_taken" })
  })

  test("an added member that fails is recovered at the same address", async () => {
    const h = await harness()
    const added = await addTeamMember(h.input, h.deps)
    h.manager.setStatus(added.member.taskId, "error")
    const replaced = await replaceTeamMember({
      teamRunId: h.teamRunId, member: "verifier", expectedTaskId: added.member.taskId, model: MODEL,
      prompt: "Recheck revision B.",
    }, h.deps)
    expect((await readMemberTaskMap(h.runtimeDir)).verifier).toBe(replaced.member.taskId)
    expect(h.manager.started.at(-1)?.memberEnv?.RUBATO_PI_ROLE).toBe("verifier")
  })
})
