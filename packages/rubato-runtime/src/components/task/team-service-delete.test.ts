import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { loadRubatoConfig } from "@rubato/config-core"
import { createRuntimeState, transitionRuntimeState } from "@rubato/team-core/team-state-store"
import { normalizeSenpiTeamSpec, teamStorageBaseDir, toTeamCoreConfig } from "@rubato/senpi-task"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { composeTaskEngine } from "./engine"
import { createTeamService } from "./team-service"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function deletionHarness(sessionId: string) {
  const cwd = mkdtempSync(join(tmpdir(), "rubato-runtime-team-delete-service-"))
  tempRoots.push(cwd)
  const rubatoConfig = loadRubatoConfig({ cwd }).config
  const engine = composeTaskEngine({ pi: new FakeExtensionAPI(), rubatoConfig, cwd, sharedParentTools: () => [] })
  engine.runtime.captureFrom({ sessionManager: { getSessionId: () => sessionId } })
  const stateDir = {
    project_dir: cwd,
    ...(engine.settings.state_dir !== undefined ? { task: { state_dir: engine.settings.state_dir } } : {}),
  }
  const config = toTeamCoreConfig(engine.settings, teamStorageBaseDir(stateDir))
  const spec = normalizeSenpiTeamSpec(
    { members: [{ name: "beta", kind: "category", category: "quick", prompt: "work" }] },
    "squad",
  )
  const creating = await createRuntimeState(spec, "lead-session", "project", config)
  const runtimeState = await transitionRuntimeState(
    creating.teamRunId,
    (state) => ({ ...state, status: "active" }),
    config,
  )
  const service = createTeamService({
    manager: engine.manager,
    destruction: engine.lifecycle,
    runtime: engine.runtime,
    settings: engine.settings,
    rubatoConfig,
    cwd,
    agentNames: new Set(Object.keys(engine.agents)),
  })
  return { runtimeState, service }
}

describe("createTeamService team deletion boundary", () => {
  test("#given canonical, foreign-owned, and uppercased run ids #when teams are deleted #then shape and ownership fences stay distinct", async () => {
    // given
    const { runtimeState, service } = await deletionHarness("other-session")
    const uppercaseId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    const unknownId = "11111111-1111-4111-8111-111111111111"

    // when / then
    await expect(service.deleteTeam({ teamRunId: uppercaseId })).rejects.toThrow("canonical lowercase UUID")
    expect(runtimeState.teamRunId).toBe(runtimeState.teamRunId.toLowerCase())
    await expect(service.deleteTeam({ teamRunId: runtimeState.teamRunId })).rejects.toThrow(
      "is not owned by the current session",
    )
    await expect(service.deleteTeam({ teamRunId: unknownId })).resolves.toEqual({
      teamRunId: unknownId,
      cancelledTaskIds: [],
    })
  })
})
