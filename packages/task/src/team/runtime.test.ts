import { stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { readMemberTaskMap } from "./member-map"
import { normalizeSenpiTeamSpec } from "./normalize"
import { createTeam } from "./runtime"
import { resolveTeamRuntimeDirs } from "./storage"
import {
  FakeTeamManager,
  cleanupTeamRuntimeTmp,
  stateDirConfig,
  taskSettings,
  tempProjectDir,
} from "./__fixtures__/runtime-fakes"

afterEach(() => {
  cleanupTeamRuntimeTmp()
})

function threeMemberSpec() {
  return normalizeSenpiTeamSpec(
    {
      members: [
        { name: "alpha", kind: "owner", model: "rubato-mock/mock-1", prompt: "task alpha" },
        { name: "beta", kind: "owner", model: "rubato-mock/mock-1", prompt: "task beta" },
        { name: "gamma", kind: "verifier", model: "rubato-mock/mock-1", prompt: "task gamma" },
      ],
    },
    "squad",
  )
}

describe("createTeam", () => {
  test("#given a member extension launch config #when a team member starts #then extension and durable identity env reach the manager spec", async () => {
    // given
    const stateDir = stateDirConfig(tempProjectDir())
    const settings = taskSettings()
    const manager = new FakeTeamManager()
    const spec = normalizeSenpiTeamSpec(
      { members: [{ name: "alpha", kind: "verifier", model: "rubato-mock/mock-1", prompt: "task alpha" }] },
      "squad",
    )

    // when
    const created = await createTeam(spec, "project", {
      manager,
      stateDir,
      taskSettings: settings,
      leadSessionId: "lead-session",
      spawnDepth: 1,
      memberExtension: {
        entryPath: "/tmp/rubato-member.js",
        inheritedExtensions: ["/tmp/mock-provider.ts"],
      },
    })

    // then
    const started = manager.started[0]
    expect(started?.extensions).toEqual(["/tmp/rubato-member.js", "/tmp/mock-provider.ts"])
    expect(started?.memberEnv?.["RUBATO_TASK_MEMBER"]).toBe(`${created.runtimeState.teamRunId}::alpha`)
    expect(started?.memberEnv?.["RUBATO_PI_ROLE"]).toBe("verifier")
    expect(created.runtimeState.members[0]?.kind).toBe("verifier")
    const config = JSON.parse(started?.memberEnv?.["RUBATO_TASK_TEAM_CONFIG"] ?? "null")
    expect(config).toMatchObject({
      stateDir: join(stateDir.project_dir, ".rubato", "task"),
      base_dir: join(stateDir.project_dir, ".rubato", "task", "teams"),
      members: ["alpha"],
    })
    expect(started?.memberScopedTools).toBeUndefined()
  })

  test("#given a 3-member spec #when created #then the team is active with 3 mapped running members", async () => {
    // given
    const stateDir = stateDirConfig(tempProjectDir())
    const settings = taskSettings()
    const manager = new FakeTeamManager()

    // when
    const created = await createTeam(threeMemberSpec(), "project", {
      manager,
      stateDir,
      taskSettings: settings,
      leadSessionId: "lead-session",
      spawnDepth: 1,
    })

    // then
    expect(created.runtimeState.status).toBe("active")
    expect(created.runtimeState.members).toHaveLength(3)
    for (const member of created.runtimeState.members) {
      expect(member.status).toBe("running")
      expect(member.sessionId).toMatch(/^sess-/)
    }
    expect(Object.keys(created.memberTaskIds).sort()).toEqual(["alpha", "beta", "gamma"])
    expect(manager.started).toHaveLength(3)
    for (const spec of manager.started) {
      expect(spec.execution_mode).toBe("process")
      expect(spec.run_in_background).toBe(true)
      expect(spec.parent_session_id).toBe("lead-session")
      expect(spec.depth).toBe(1)
      expect(spec.name).toMatch(/^team:[0-9a-f-]+:(alpha|beta|gamma)$/)
    }
  })

  test("#given roles, prompts, and a resolved model #when created #then member views carry role, model, task id, and prompt excerpt", async () => {
    // given
    const stateDir = stateDirConfig(tempProjectDir())
    const manager = new FakeTeamManager({
      behaviors: [
        {
          kind: "ok",
          resolvedModel: {
            provider: "anthropic",
            model_id: "claude-opus-4-7",
            display: "Claude Opus 4.7",
            reasoning_effort: "high",
            source: "model",
          },
        },
        { kind: "ok" },
        { kind: "ok" },
      ],
    })

    // when
    const created = await createTeam(threeMemberSpec(), "project", {
      manager,
      stateDir,
      taskSettings: taskSettings(),
      leadSessionId: "lead-session",
      spawnDepth: 1,
    })

    // then
    const [alpha, beta, gamma] = created.members
    expect(created.members).toHaveLength(3)
    expect(alpha).toMatchObject({
      name: "alpha",
      status: "running",
      role: { kind: "owner", model: "rubato-mock/mock-1" },
      promptExcerpt: "task alpha",
    })
    expect(alpha?.taskId).toMatch(/^st_/)
    expect(alpha?.model).toMatchObject({ provider: "anthropic", display: "Claude Opus 4.7", reasoning_effort: "high" })
    expect(beta?.model).toBeUndefined()
    expect(gamma).toMatchObject({
      name: "gamma",
      role: { kind: "verifier", model: "rubato-mock/mock-1" },
      promptExcerpt: "task gamma",
    })
  })

  test("#given member prompts #when members start #then every bootstrap teaches injection-driven work after the role", async () => {
    // given
    const stateDir = stateDirConfig(tempProjectDir())
    const manager = new FakeTeamManager()
    const spec = normalizeSenpiTeamSpec(
      {
        members: [
          { name: "alpha", kind: "owner", model: "rubato-mock/mock-1", prompt: "task alpha" },
          { name: "beta", kind: "owner", model: "rubato-mock/mock-1", prompt: "task beta" },
        ],
      },
      "squad",
    )

    // when
    await createTeam(spec, "project", {
      manager,
      stateDir,
      taskSettings: taskSettings(),
      leadSessionId: "lead-session",
      spawnDepth: 1,
    })

    // then
    const [alphaStart, betaStart] = manager.started
    for (const start of [alphaStart, betaStart]) {
      expect(start?.prompt).toContain("team_send")
    }
    expect(alphaStart?.prompt).toContain("'alpha'")
    expect(alphaStart?.prompt).toContain("'squad'")
    expect(alphaStart?.prompt).toContain("task alpha")
    expect(alphaStart?.prompt.indexOf("end your turn")).toBeLessThan(alphaStart?.prompt.indexOf("task alpha"))
    expect(betaStart?.prompt).toContain("'beta'")
    expect(betaStart?.prompt).toContain("'squad'")
  })

  test("#given the created team #when the sidecar is read #then it maps every member to its st_ id", async () => {
    // given
    const stateDir = stateDirConfig(tempProjectDir())
    const settings = taskSettings()
    const manager = new FakeTeamManager()
    const created = await createTeam(threeMemberSpec(), "project", {
      manager,
      stateDir,
      taskSettings: settings,
      leadSessionId: "lead-session",
      spawnDepth: 1,
    })

    // when
    const runtimeDir = resolveTeamRuntimeDirs(stateDir, created.runtimeState.teamRunId).runtimeDir
    const sidecar = await readMemberTaskMap(runtimeDir)

    // then
    expect(sidecar).toEqual(created.memberTaskIds)
    expect(Object.values(sidecar).every((id) => id.startsWith("st_"))).toBe(true)
  })

  test("#given a member with a worktreePath #when created #then the cwd is passed and the directory is made", async () => {
    // given
    const projectDir = tempProjectDir()
    const stateDir = stateDirConfig(projectDir)
    const worktreePath = join(projectDir, "wt", "alpha")
    const spec = normalizeSenpiTeamSpec(
      { members: [{ name: "alpha", kind: "owner", model: "rubato-mock/mock-1", prompt: "x", worktreePath }] },
      "squad",
    )
    const manager = new FakeTeamManager()

    // when
    await createTeam(spec, "project", {
      manager,
      stateDir,
      taskSettings: taskSettings(),
      leadSessionId: "lead-session",
      spawnDepth: 1,
    })

    // then
    expect(manager.started[0]?.cwd).toBe(worktreePath)
    expect((await stat(worktreePath)).isDirectory()).toBe(true)
  })

})
