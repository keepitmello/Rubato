/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createScheduleStore, type ScheduleStore } from "@rubato/schedule-core"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { SCHEDULE_TOOL_NAME, createScheduleComponent, runScheduleTool } from "./index"

let root: string
let session: string
let store: ScheduleStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rubato-schedule-tool-"))
  session = join(root, "project")
  await mkdir(join(session, "sub"), { recursive: true })
  store = createScheduleStore({ root: join(root, "schedule") })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join("\n")

describe("schedule tool", () => {
  it("#given a request in a session #when it registers a task #then it defaults to this folder and the default model and says when it runs", async () => {
    const result = await runScheduleTool(store, {
      action: "create", name: "Dependency check", prompt: "Check this repo's dependencies",
      schedule: { kind: "weekdays", time: "09:00" },
    }, session)
    expect(result.isError).toBeUndefined()
    const [task] = (await store.list()).tasks
    expect(task).toMatchObject({ name: "Dependency check", cwd: session, model: null, enabled: true })
    expect(text(result)).toContain("Weekdays (Mon–Fri) at 9:00 AM")
    expect(text(result)).toContain(`folder: ${session}`)
    expect(text(result)).toContain("user's default model")
    expect(text(result)).toContain(task!.nextRunAt!)
    expect(text(result)).toContain("scheduler is not running")
  })

  it("#given a relative or home folder #when it registers #then the folder resolves against the session", async () => {
    await runScheduleTool(store, { action: "create", name: "Sub", prompt: "x", cwd: "sub", schedule: { kind: "daily", time: "08:00" } }, session)
    expect((await store.list()).tasks[0]!.cwd).toBe(join(session, "sub"))
  })

  it("#given a schedule the picker cannot express #when it registers #then it refuses and names the closest supported one", async () => {
    const every5 = await runScheduleTool(store, { action: "create", name: "Five", prompt: "x", schedule: { kind: "interval", everyHours: 5 } }, session)
    expect(every5.isError).toBe(true)
    expect(text(every5)).toMatch(/Every (4|6) hours/)
    expect(text(every5)).toContain("Ask the user")
    const monthly = await runScheduleTool(store, { action: "create", name: "Monthly", prompt: "x", schedule: { kind: "monthly" as never, time: "09:00" } }, session)
    expect(monthly.isError).toBe(true)
    const overnight = await runScheduleTool(store, { action: "create", name: "Night", prompt: "x",
      schedule: { kind: "interval", everyHours: 2, window: { start: "22:00", end: "06:00" } } }, session)
    expect(text(overnight)).toContain("Every 2 hours")
    const past = await runScheduleTool(store, { action: "create", name: "Past", prompt: "x", schedule: { kind: "once", date: "2020-01-01", time: "09:00" } }, session)
    expect(text(past)).toContain("already passed")
    expect((await store.list()).tasks).toEqual([])
  })

  it("#given an existing task #when it updates, lists, previews and deletes by name #then only the given fields change", async () => {
    await runScheduleTool(store, { action: "create", name: "Morning research", prompt: "summarize", model: "anthropic/claude-sonnet-5", schedule: { kind: "daily", time: "09:00" } }, session)
    const updated = await runScheduleTool(store, { action: "update", task: "morning research", schedule: { kind: "weekly", days: ["mon", "fri"], time: "07:30" } }, session)
    expect(text(updated)).toContain("Every Mon, Fri at 7:30 AM")
    const [task] = (await store.list()).tasks
    expect(task).toMatchObject({ prompt: "summarize", model: "anthropic/claude-sonnet-5", cwd: session })
    const cleared = await runScheduleTool(store, { action: "update", task: task!.id, model: "" }, session)
    expect(text(cleared)).toContain("user's default model")
    expect(text(await runScheduleTool(store, { action: "list" }, session))).toContain("Morning research")
    expect(text(await runScheduleTool(store, { action: "preview", schedule: { kind: "interval", everyHours: 3 } }, session))).toContain("Every 3 hours")
    const deleted = await runScheduleTool(store, { action: "delete", task: "Morning research" }, session)
    expect(text(deleted)).toContain("Sessions it already created are kept")
    expect((await store.list()).tasks).toEqual([])
  })

  it("#given no scheduler #when asked to run now #then it refuses instead of pretending", async () => {
    await runScheduleTool(store, { action: "create", name: "Now", prompt: "x", schedule: { kind: "daily", time: "09:00" } }, session)
    const result = await runScheduleTool(store, { action: "run_now", task: "Now" }, session)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("scheduler is not running")
  })

  it("#given a running scheduler #when asked to run now #then the request is queued for it", async () => {
    await runScheduleTool(store, { action: "create", name: "Now", prompt: "x", schedule: { kind: "daily", time: "09:00" } }, session)
    await writeFile(store.files.scheduler, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), lastTickAt: new Date().toISOString() }))
    const result = await runScheduleTool(store, { action: "run_now", task: "Now" }, session)
    expect(result.isError).toBeUndefined()
    expect((await store.list()).tasks[0]!.running).toBe(true)
  })

  it("#given an unknown task name #when it edits #then it refuses", async () => {
    const result = await runScheduleTool(store, { action: "delete", task: "nothing" }, session)
    expect(result.isError).toBe(true)
  })
})

describe("createScheduleComponent", () => {
  it("#given a session #when registered #then the schedule tool is always visible and bound to the session folder", async () => {
    const pi = new FakeExtensionAPI()
    const component = createScheduleComponent({ resolveCwd: () => session, createStore: () => store })
    await component.register(pi, { logger: { info() {}, warn() {}, error() {} }, config: { getFlag: () => undefined } })
    const tool = pi.tools.find((item) => item.name === SCHEDULE_TOOL_NAME) as Record<string, unknown> & { execute: Function }
    expect(tool.exposure).toBe("direct")
    await tool.execute("call-1", { action: "create", name: "Bound", prompt: "x", schedule: { kind: "daily", time: "10:00" } })
    expect((await store.list()).tasks[0]!.cwd).toBe(pi.cwd ?? session)
  })
})
