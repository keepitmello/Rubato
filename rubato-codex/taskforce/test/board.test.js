import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { afterEach, test } from "node:test"

import { BoardError, openBoard, resolveStateDir } from "../src/board.js"

const NODE = process.execPath
const CLI = path.resolve("src/cli.js")
const cleanups = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(runId = "run-a") {
  const stateDir = await mkdtemp(path.join(tmpdir(), "taskforce-test-"))
  cleanups.push(stateDir)
  const scope = { workspace: "/stable/workspace", run_id: runId }
  return { stateDir, scope, board: openBoard({ stateDir }) }
}

function cli(stateDir, operation, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, operation, JSON.stringify(input)], {
      cwd: path.resolve("."),
      env: { ...process.env, TASKFORCE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, body: JSON.parse(stdout), stderr }))
  })
}

test("CRUD persists mission metadata, completion evidence, and audit events", async () => {
  const { board, scope, stateDir } = await fixture()
  const created = board.create({
    ...scope,
    subject: "Implement board",
    description: "Build the shared work board",
    outcome: "working board",
    write_ownership: "taskforce/**",
    budget: "15m",
    done_evidence: "tests pass",
  })
  assert.equal(created.id, "1")
  assert.equal(created.metadata.writeOwnership, "taskforce/**")
  board.update({ ...scope, task_id: "1", actor: "/root/owner", status: "claimed" })
  board.update({ ...scope, task_id: "1", actor: "/root/owner", status: "in_progress" })
  const completed = board.update({ ...scope, task_id: "1", actor: "/root/owner", status: "completed", evidence: "node --test passed" })
  assert.deepEqual(completed.evidence, ["node --test passed"])
  assert.deepEqual(completed.events.map((event) => event.kind), ["created", "status_changed", "status_changed", "status_changed"])
  board.close()

  const reopened = openBoard({ stateDir })
  assert.equal(reopened.get({ ...scope, task_id: 1 }).status, "completed")
  reopened.close()
})

test("workspace and run id isolate boards in one database", async () => {
  const { board, scope } = await fixture()
  board.create({ ...scope, subject: "A", description: "scope A" })
  board.create({ workspace: scope.workspace, run_id: "run-b", subject: "B", description: "scope B" })
  board.create({ workspace: "/other/workspace", run_id: scope.run_id, subject: "C", description: "scope C" })
  assert.deepEqual(board.list(scope).map((task) => task.subject), ["A"])
  assert.deepEqual(board.list({ workspace: scope.workspace, run_id: "run-b" }).map((task) => task.subject), ["B"])
  assert.deepEqual(board.list({ workspace: "/other/workspace", run_id: scope.run_id }).map((task) => task.subject), ["C"])
  board.close()
})

test("scope requires an absolute workspace and pending tasks can be deleted", async () => {
  const { board, scope } = await fixture()
  assert.throws(
    () => board.list({ workspace: "relative", run_id: scope.run_id }),
    (error) => error instanceof BoardError && error.code === "invalid_input",
  )
  const task = board.create({ ...scope, subject: "unused", description: "remove before claim" })
  assert.equal(board.update({ ...scope, task_id: task.id, actor: "lead", status: "deleted" }).status, "deleted")
  board.close()
})

test("state directory precedence is explicit override, CODEX_HOME, then the live default", async () => {
  assert.equal(
    resolveStateDir({}, { TASKFORCE_STATE_DIR: "/explicit", CODEX_HOME: "/codex" }, "/home"),
    "/explicit",
  )
  assert.equal(resolveStateDir({}, { CODEX_HOME: "/codex" }, "/home"), "/codex/taskforce")
  assert.equal(resolveStateDir({}, {}, "/home"), "/home/.codex/taskforce")
})

test("dependencies must exist and prevent claim until completed", async () => {
  const { board, scope } = await fixture()
  assert.throws(
    () => board.create({ ...scope, subject: "bad", description: "bad dependency", blocked_by: [99] }),
    (error) => error instanceof BoardError && error.code === "not_found",
  )
  const blocker = board.create({ ...scope, subject: "blocker", description: "first" })
  const blocked = board.create({ ...scope, subject: "blocked", description: "second", blocked_by: [blocker.id] })
  assert.throws(
    () => board.update({ ...scope, task_id: blocked.id, actor: "agent-b", status: "claimed" }),
    (error) => error instanceof BoardError && error.code === "blocked_by",
  )
  board.update({ ...scope, task_id: blocker.id, actor: "agent-a", status: "in_progress" })
  board.update({ ...scope, task_id: blocker.id, actor: "agent-a", status: "completed", evidence: "done" })
  assert.equal(board.update({ ...scope, task_id: blocked.id, actor: "agent-b", status: "claimed" }).owner, "agent-b")
  board.close()
})

test("ordinary updates enforce owner while explicit recovery is audited", async () => {
  const { board, scope } = await fixture()
  const task = board.create({ ...scope, subject: "owned", description: "owner boundary" })
  board.update({ ...scope, task_id: task.id, actor: "agent-a", status: "claimed" })
  assert.throws(
    () => board.update({ ...scope, task_id: task.id, actor: "agent-b", status: "in_progress" }),
    (error) => error instanceof BoardError && error.code === "cross_owner",
  )
  const recovered = board.update({
    ...scope,
    task_id: task.id,
    actor: "lead",
    reassign_to: "agent-b",
    recovery_reason: "agent-a is unavailable",
  })
  assert.equal(recovered.owner, "agent-b")
  assert.equal(recovered.status, "claimed")
  assert.deepEqual(recovered.events.at(-1).details, { from: "agent-a", to: "agent-b", reason: "agent-a is unavailable" })
  board.close()
})

test("independent CLI processes allow exactly one claimant", async () => {
  const { board, scope, stateDir } = await fixture()
  const task = board.create({ ...scope, subject: "race", description: "claim concurrently" })
  board.close()
  const results = await Promise.all([
    cli(stateDir, "update", { ...scope, task_id: task.id, actor: "agent-a", status: "claimed" }),
    cli(stateDir, "update", { ...scope, task_id: task.id, actor: "agent-b", status: "claimed" }),
  ])
  assert.equal(results.filter((result) => result.body.ok).length, 1)
  assert.equal(results.filter((result) => result.body.error?.code === "already_claimed").length, 1)
})

test("independent process status updates cannot resurrect a deleted task", async () => {
  const { board, scope, stateDir } = await fixture()
  const task = board.create({ ...scope, subject: "race", description: "update concurrently" })
  board.update({ ...scope, task_id: task.id, actor: "agent-a", status: "in_progress" })
  board.close()
  const results = await Promise.all([
    cli(stateDir, "update", { ...scope, task_id: task.id, actor: "agent-a", status: "completed", evidence: "finished" }),
    cli(stateDir, "update", { ...scope, task_id: task.id, actor: "agent-a", status: "deleted" }),
  ])
  assert.equal(results.filter((result) => result.body.error?.code === "internal").length, 0)
  const reopened = openBoard({ stateDir })
  assert.equal(reopened.get({ ...scope, task_id: task.id }).status, "deleted")
  reopened.close()
})

test("CLI processes and direct API share one core and persisted state", async () => {
  const { board, scope, stateDir } = await fixture()
  board.close()
  const created = await cli(stateDir, "create", { ...scope, subject: "CLI", description: "same core" })
  assert.equal(created.code, 0)
  const fetched = await cli(stateDir, "get", { ...scope, task_id: created.body.result.id })
  assert.equal(fetched.body.result.subject, "CLI")
  const reopened = openBoard({ stateDir })
  assert.equal(reopened.get({ ...scope, task_id: created.body.result.id }).subject, "CLI")
  reopened.close()
})
