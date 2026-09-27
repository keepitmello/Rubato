import { describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { claimTeamTask, createTeamTask, listTeamTasks, updateTeamTaskStatus, type ActiveTeamSummary } from "@rubato/task"
import type { SessionShutdownEvent } from "@code-yeongyu/senpi"
import { TeamModeConfigSchema } from "@rubato/team-core/config"

import { wireHarness } from "./event-bridge.test-harness"
import type { Task } from "@rubato/team-core/types"

import {
  createTeamBoardRpcBridge,
  MAX_BOARD_DESCRIPTION_CHARS,
  TEAM_BOARD_UPDATED_EVENT,
} from "./team-board-rpc-bridge"

const LEAD = "lead-session"
const UPDATED_AT = Date.UTC(2025, 0, 2, 3, 4, 5)

function team(overrides: Partial<ActiveTeamSummary> & Pick<ActiveTeamSummary, "teamRunId" | "teamName">): ActiveTeamSummary {
  return { status: "active", memberCount: 2, scope: "project", leadSessionId: LEAD, ...overrides }
}

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    version: 1,
    subject: `subject ${overrides.id}`,
    description: `description ${overrides.id}`,
    status: "pending",
    blocks: [],
    blockedBy: [],
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

function harness(options: { withRpc?: boolean } = {}) {
  const emitted: { name: string; data: unknown }[] = []
  let sessionId: string | undefined = LEAD
  let teams: ActiveTeamSummary[] = []
  const boards = new Map<string, Task[]>()
  let listTeamsCalls = 0
  const bridge = createTeamBoardRpcBridge({
    pi: options.withRpc === false ? {} : { rpc: { emit: (name, data) => emitted.push({ name, data }) } },
    sessionId: () => sessionId,
    listTeams: async () => {
      listTeamsCalls += 1
      await Promise.resolve()
      return teams
    },
    listTasks: async (teamRunId) => boards.get(teamRunId) ?? [],
  })
  return {
    bridge,
    emitted,
    boards,
    setTeams: (next: ActiveTeamSummary[]) => { teams = next },
    setSession: (next: string | undefined) => { sessionId = next },
    listTeamsCalls: () => listTeamsCalls,
  }
}

describe("team board RPC bridge", () => {
  it("#given a team led by the session #when attached #then emits the contract shape without deleted tasks, ordered by numeric id", async () => {
    const h = harness()
    h.setTeams([team({ teamRunId: "run-a", teamName: "alpha" })])
    h.boards.set("run-a", [
      task({ id: "10", status: "completed", owner: "worker" }),
      task({ id: "2", status: "in_progress", owner: "worker", blockedBy: ["1"] }),
      task({ id: "3", status: "deleted" }),
      task({ id: "1", status: "claimed", description: "x".repeat(MAX_BOARD_DESCRIPTION_CHARS + 5) }),
    ])

    h.bridge.attach()
    await h.bridge.idle()

    expect(h.emitted).toEqual([{
      name: TEAM_BOARD_UPDATED_EVENT,
      data: {
        parent_session_id: LEAD,
        teams: [{
          team_run_id: "run-a",
          team_name: "alpha",
          tasks: [
            {
              id: "1",
              subject: "subject 1",
              description: "x".repeat(MAX_BOARD_DESCRIPTION_CHARS),
              description_truncated: true,
              status: "claimed",
              blocked_by: [],
              updated_at: "2025-01-02T03:04:05.000Z",
            },
            {
              id: "2",
              subject: "subject 2",
              description: "description 2",
              status: "in_progress",
              owner: "worker",
              blocked_by: ["1"],
              updated_at: "2025-01-02T03:04:05.000Z",
            },
            {
              id: "10",
              subject: "subject 10",
              description: "description 10",
              status: "completed",
              owner: "worker",
              blocked_by: [],
              updated_at: "2025-01-02T03:04:05.000Z",
            },
          ],
        }],
      },
    }])
  })

  it("#given only a foreign lead's team #when attached and scheduled #then nothing is emitted", async () => {
    const h = harness()
    h.setTeams([team({ teamRunId: "run-f", teamName: "foreign", leadSessionId: "other-session" })])
    h.boards.set("run-f", [task({ id: "1" })])

    h.bridge.attach()
    h.bridge.schedule()
    await h.bridge.idle()

    expect(h.emitted).toEqual([])
  })

  it("#given a mixed team list #when emitted #then only the session's own teams appear", async () => {
    const h = harness()
    h.setTeams([
      team({ teamRunId: "run-f", teamName: "foreign", leadSessionId: "other-session" }),
      team({ teamRunId: "run-a", teamName: "alpha" }),
    ])

    h.bridge.attach()
    await h.bridge.idle()

    const data = h.emitted[0]?.data as { teams: { team_run_id: string }[] }
    expect(data.teams.map((entry) => entry.team_run_id)).toEqual(["run-a"])
  })

  it("#given an emitted board #when the data is unchanged #then it is not re-emitted, and a status change is", async () => {
    const h = harness()
    h.setTeams([team({ teamRunId: "run-a", teamName: "alpha" })])
    h.boards.set("run-a", [task({ id: "1", status: "pending" })])
    h.bridge.attach()
    await h.bridge.idle()

    h.bridge.tick()
    h.bridge.schedule()
    await h.bridge.idle()
    expect(h.emitted).toHaveLength(1)

    h.boards.set("run-a", [task({ id: "1", status: "in_progress", owner: "worker", updatedAt: UPDATED_AT + 1_000 })])
    h.bridge.tick()
    await h.bridge.idle()

    expect(h.emitted).toHaveLength(2)
    const data = h.emitted[1]?.data as { teams: { tasks: { status: string; owner?: string }[] }[] }
    expect(data.teams[0]?.tasks[0]).toMatchObject({ status: "in_progress", owner: "worker" })
  })

  it("#given an emitted team #when the team goes away #then emits teams: [] once and the tick stops polling", async () => {
    const h = harness()
    h.setTeams([team({ teamRunId: "run-a", teamName: "alpha" })])
    h.bridge.attach()
    await h.bridge.idle()

    h.setTeams([])
    h.bridge.schedule()
    await h.bridge.idle()
    h.bridge.schedule()
    await h.bridge.idle()

    expect(h.emitted.map((entry) => entry.data)).toEqual([
      expect.objectContaining({ teams: [expect.objectContaining({ team_run_id: "run-a" })] }),
      { parent_session_id: LEAD, teams: [] },
    ])
    const reads = h.listTeamsCalls()
    h.bridge.tick()
    await h.bridge.idle()
    expect(h.listTeamsCalls()).toBe(reads)
  })

  it("#given no team was ever shown #when the session leads none #then no empty snapshot is emitted and ticks do not read", async () => {
    const h = harness()
    h.bridge.attach()
    await h.bridge.idle()
    const reads = h.listTeamsCalls()
    h.bridge.tick()
    await h.bridge.idle()

    expect(h.emitted).toEqual([])
    expect(h.listTeamsCalls()).toBe(reads)
  })

  it("#given a burst of schedules #when a read is in flight #then reads coalesce into one follow-up", async () => {
    const h = harness()
    h.setTeams([team({ teamRunId: "run-a", teamName: "alpha" })])
    h.bridge.attach()
    for (let index = 0; index < 20; index += 1) h.bridge.schedule()
    await h.bridge.idle()

    expect(h.listTeamsCalls()).toBe(2)
  })

  it("#given an attached bridge #when detached or disposed #then later changes are not emitted", async () => {
    const h = harness()
    h.setTeams([team({ teamRunId: "run-a", teamName: "alpha" })])
    h.bridge.attach()
    await h.bridge.idle()

    h.bridge.detach()
    h.boards.set("run-a", [task({ id: "1" })])
    h.bridge.schedule()
    h.bridge.tick()
    await h.bridge.idle()
    expect(h.emitted).toHaveLength(1)

    h.bridge.attach()
    await h.bridge.idle()
    expect(h.emitted).toHaveLength(2)

    h.bridge.dispose()
    h.boards.set("run-a", [task({ id: "1", status: "completed" })])
    h.bridge.attach()
    h.bridge.schedule()
    h.bridge.tick()
    await h.bridge.idle()
    expect(h.emitted).toHaveLength(2)
  })

  it("#given a read in flight #when the session detaches before it resolves #then the stale result is dropped", async () => {
    const h = harness()
    h.setTeams([team({ teamRunId: "run-a", teamName: "alpha" })])
    h.bridge.attach()
    h.bridge.detach()
    await h.bridge.idle()

    expect(h.emitted).toEqual([])
  })

  it("#given no RPC channel #when attached #then the board is never read", async () => {
    const h = harness({ withRpc: false })
    h.setTeams([team({ teamRunId: "run-a", teamName: "alpha" })])
    h.bridge.attach()
    h.bridge.schedule()
    await h.bridge.idle()

    expect(h.listTeamsCalls()).toBe(0)
  })

  it("#given the real file board #when a member claims and completes a task out of process #then the next ticks carry each status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "team-board-bridge-"))
    try {
      const config = TeamModeConfigSchema.parse({ base_dir: root, enabled: true })
      const teamRunId = randomUUID()
      const ctx = { teamRunId, config }
      const emitted: unknown[] = []
      const bridge = createTeamBoardRpcBridge({
        pi: { rpc: { emit: (_name, data) => emitted.push(data) } },
        sessionId: () => LEAD,
        listTeams: async () => [team({ teamRunId, teamName: "alpha" })],
        listTasks: (id) => listTeamTasks({ teamRunId: id, config }),
      })
      const statuses = () => (emitted.at(-1) as { teams: { tasks: { status: string; owner?: string }[] }[] })
        .teams[0]?.tasks.map((entry) => `${entry.status}:${entry.owner ?? "-"}`)

      const created = await createTeamTask(ctx, { subject: "write docs", description: "d", status: "pending" })
      bridge.attach()
      await bridge.idle()
      expect(statuses()).toEqual(["pending:-"])

      await claimTeamTask(ctx, created.id, "worker")
      bridge.tick()
      await bridge.idle()
      expect(statuses()).toEqual(["claimed:worker"])

      await updateTeamTaskStatus(ctx, created.id, "in_progress", "worker")
      bridge.tick()
      await bridge.idle()
      expect(statuses()).toEqual(["in_progress:worker"])

      await updateTeamTaskStatus(ctx, created.id, "completed", "worker")
      bridge.tick()
      await bridge.idle()
      expect(statuses()).toEqual(["completed:worker"])

      await updateTeamTaskStatus(ctx, created.id, "deleted", "worker")
      bridge.tick()
      await bridge.idle()
      expect(statuses()).toEqual([])
      expect(emitted).toHaveLength(5)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("#given the event bridge #when the session starts, switches and shuts down #then the board bridge follows attach, detach and dispose", async () => {
    const { pi, boardCalls } = wireHarness(LEAD, { withRpc: true })

    await pi.dispatch("session_start", {}, {})
    await pi.dispatch("session_before_switch", {}, {})
    await pi.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" } as unknown as SessionShutdownEvent, {})

    expect(boardCalls).toEqual(["attach", "detach", "dispose"])
  })
})
