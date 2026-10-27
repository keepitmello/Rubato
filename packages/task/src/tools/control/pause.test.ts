import { afterEach, describe, expect, test } from "bun:test"

import { baseSpec, cleanupProjects, makeManager } from "../../manager/__fixtures__/manager-fakes"
import { createTaskPauseTool, runTaskPause } from "./pause"
import { runTaskSend } from "./send"

afterEach(cleanupProjects)

const TEAM = "11111111-1111-4111-8111-111111111111"
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222"

describe("runTaskPause", () => {
  test("#given a running child #when paused #then it stops without being cancelled", async () => {
    const { manager } = makeManager({})
    const started = await manager.start(baseSpec({ parent_session_id: "p1" }))
    if (started.kind !== "started") throw new Error("expected started")

    const result = await runTaskPause(manager, { agentId: started.task_id })

    expect(result.details).toEqual({ kind: "paused", agentIds: [started.task_id] })
    expect(manager.get(started.task_id)?.status).toBe("interrupted")
  })

  test("#given a paused child #when AgentSend follows up #then the same session resumes", async () => {
    const { manager } = makeManager({})
    const started = await manager.start(baseSpec({ parent_session_id: "p1" }))
    if (started.kind !== "started") throw new Error("expected started")
    await runTaskPause(manager, { agentId: started.task_id })

    const result = await runTaskSend(manager, { agentId: started.task_id, message: "carry on" }, "p1")

    expect(result.details.kind).toBe("revived")
    expect(manager.get(started.task_id)?.status).toBe("running")
  })

  test("#given a team with running members and an unrelated child #when the team is paused #then only that team's members stop", async () => {
    const { manager } = makeManager({})
    const alice = await manager.start(baseSpec({ name: `team:${TEAM}:alice` }))
    const bob = await manager.start(baseSpec({ name: `team:${TEAM}:bob` }))
    const other = await manager.start(baseSpec({ name: `team:${OTHER_TEAM}:carol` }))
    const plain = await manager.start(baseSpec({ name: "plain" }))
    if (alice.kind !== "started" || bob.kind !== "started" || other.kind !== "started" || plain.kind !== "started") throw new Error("expected started")

    const result = await runTaskPause(manager, { team_run_id: TEAM })

    expect(result.details.kind).toBe("paused")
    if (result.details.kind !== "paused") return
    expect([...result.details.agentIds].sort()).toEqual([alice.task_id, bob.task_id].sort())
    expect(manager.get(alice.task_id)?.status).toBe("interrupted")
    expect(manager.get(bob.task_id)?.status).toBe("interrupted")
    expect(manager.get(other.task_id)?.status).toBe("running")
    expect(manager.get(plain.task_id)?.status).toBe("running")
  })

  test("#given a team with nothing running #when paused #then it is a no-op", async () => {
    const { manager } = makeManager({})

    const result = await runTaskPause(manager, { team_run_id: TEAM })

    expect(result.details.kind).toBe("team_noop")
  })

  test("#given an already paused child #when paused again #then it is a no-op with its status", async () => {
    const { manager } = makeManager({})
    const started = await manager.start(baseSpec({ parent_session_id: "p1" }))
    if (started.kind !== "started") throw new Error("expected started")
    await runTaskPause(manager, { agentId: started.task_id })

    const result = await runTaskPause(manager, { agentId: started.task_id })

    expect(result.details.kind).toBe("noop")
    if (result.details.kind !== "noop") return
    expect(result.details.status).toBe("interrupted")
  })

  test("#given both or neither target #when paused #then invalid_arguments is returned", async () => {
    const { manager } = makeManager({})

    expect((await runTaskPause(manager, {})).details.kind).toBe("invalid_arguments")
    expect((await runTaskPause(manager, { agentId: "st_x", team_run_id: TEAM })).details.kind).toBe("invalid_arguments")
  })

  test("#given an unknown id #when paused #then not_found is returned", async () => {
    const { manager } = makeManager({})

    expect((await runTaskPause(manager, { agentId: "st_deadbeef" })).details.kind).toBe("not_found")
  })

  test("#given the tool #when created #then it is AgentPause and points to AgentSend for resuming", () => {
    const { manager } = makeManager({})

    const tool = createTaskPauseTool({ manager })

    expect(tool.name).toBe("AgentPause")
    expect(tool.description).toContain("AgentSend")
  })
})
