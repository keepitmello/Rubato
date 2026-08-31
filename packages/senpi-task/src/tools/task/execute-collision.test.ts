import { afterEach, describe, expect, test } from "bun:test"

import { collisionStore } from "../../manager/__fixtures__/collision-store"
import { FakeRunner, categoryPlanner, cleanupProjects, settings, tempProject } from "../../manager/__fixtures__/manager-fakes"
import { createTaskManager } from "../../manager"
import { createTaskRecordStore } from "../../store"
import { CTX, LIVE_MODEL, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"

afterEach(cleanupProjects)

function buildCollisionExecute() {
  const project = tempProject()
  const inner = createTaskRecordStore({ project_dir: project })
  const manager = createTaskManager({
    store: collisionStore(inner).store,
    runners: { "in-process": new FakeRunner(), process: new FakeRunner() },
    planner: categoryPlanner(),
    config: settings({ default_concurrency: 5, max_depth: 1 }),
    cwd: project,
  })
  return buildTaskExecute(makeDeps(manager))
}

describe("buildTaskExecute collision handling", () => {
  test("#given a first-save collision #when one agent executes #then it reports a normal started result without the raw collision", async () => {
    const execute = buildCollisionExecute()

    const result = await execute("collision-single", { prompt: "work", model: LIVE_MODEL }, undefined, undefined, CTX)

    expect(result.details.status).toBe("running")
    expect(result.details.agentId).toMatch(/^st_[0-9a-f]{8}$/)
    expect(JSON.stringify(result)).not.toContain("already exists")
  })
})
