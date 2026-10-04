import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"
import { TeamModeConfigSchema } from "@rubato/team-core/config"
import { createRuntimeState } from "@rubato/team-core/team-state-store"

import { createMemberBoardService, type ParsedMemberExtensionEnv } from "./index"

const STATE_LESS_TEAM_RUN_ID = "55555555-5555-4555-8555-555555555555"
const OTHER_TEAM_RUN_ID = "66666666-6666-4666-8666-666666666666"
const TEAM_NAME = "pi-1-0"
const OTHER_TEAM_NAME = "memory-english-2"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type GuardFixture = {
  readonly parsed: ParsedMemberExtensionEnv
}

/**
 * Builds a member board whose own run is the only team on disk. The team name lives in the run's own
 * state.json, the same file the runtime writes, so these cases exercise the real lookup — not a stub.
 */
async function createGuardFixture(withState: boolean): Promise<GuardFixture> {
  const root = mkdtempSync(join(tmpdir(), "senpi-member-board-guard-"))
  roots.push(root)
  const stateDir = join(root, "state")
  const sessionDir = join(root, "sessions")
  const baseDir = join(stateDir, "teams")
  const config = { ...TeamModeConfigSchema.parse({ base_dir: baseDir }), base_dir: baseDir }
  let teamRunId = STATE_LESS_TEAM_RUN_ID
  if (withState) {
    const runtimeState = await createRuntimeState({
      version: 1,
      name: TEAM_NAME,
      createdAt: 1,
      members: [{ kind: "owner", name: "alice", model: "test/model", prompt: "work", backendType: "in-process", isActive: true }],
    }, undefined, "user", config)
    teamRunId = runtimeState.teamRunId
  }
  return {
    parsed: {
      teamRunId,
      memberName: "alice",
      taskId: "st_00000001",
      stateDir,
      sessionDir,
      config,
      members: ["alice"],
    },
  }
}

describe("member board team guard", () => {
  test("#given the member's own run id #when it uses the board #then the task is created", async () => {
    const { parsed } = await createGuardFixture(true)
    const service = createMemberBoardService(parsed)

    const task = await service.createTask(parsed.teamRunId, { subject: "s", description: "d", status: "pending" })

    expect(task.subject).toBe("s")
    expect(await service.listTasks(parsed.teamRunId)).toHaveLength(1)
  })

  test("#given the member's own team name #when it uses the board #then the task is created", async () => {
    const { parsed } = await createGuardFixture(true)
    const service = createMemberBoardService(parsed)

    const task = await service.createTask(TEAM_NAME, { subject: "s", description: "d", status: "pending" })

    expect(task.subject).toBe("s")
    expect(await service.listTasks(TEAM_NAME)).toHaveLength(1)
  })

  test("#given another team's run id #when it uses the board #then it is refused with this member's run id", async () => {
    const { parsed } = await createGuardFixture(true)
    const service = createMemberBoardService(parsed)

    const caught = await service.createTask(OTHER_TEAM_RUN_ID, { subject: "s", description: "d", status: "pending" })
      .then(() => undefined, (error: unknown) => error)

    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).toContain(OTHER_TEAM_RUN_ID)
    expect(String(caught)).toContain(parsed.teamRunId)
    expect(String(caught)).toContain(TEAM_NAME)
    expect(await service.listTasks(parsed.teamRunId)).toHaveLength(0)
  })

  test("#given another team's name #when it uses the board #then it is refused with this member's run id", async () => {
    const { parsed } = await createGuardFixture(true)
    const service = createMemberBoardService(parsed)

    const caught = await service.listTasks(OTHER_TEAM_NAME).then(() => undefined, (error: unknown) => error)

    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).toContain(OTHER_TEAM_NAME)
    expect(String(caught)).toContain(parsed.teamRunId)
    expect(String(caught)).toContain(TEAM_NAME)
  })

  test("#given no readable team state #when it uses the board #then the run id still works and a foreign value names the run id", async () => {
    const { parsed } = await createGuardFixture(false)
    const service = createMemberBoardService(parsed)

    expect((await service.createTask(parsed.teamRunId, { subject: "s", description: "d", status: "pending" })).subject).toBe("s")
    const caught = await service.getTask(OTHER_TEAM_NAME, "1").then(() => undefined, (error: unknown) => error)

    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).toContain(OTHER_TEAM_NAME)
    expect(String(caught)).toContain(parsed.teamRunId)
  })
})
