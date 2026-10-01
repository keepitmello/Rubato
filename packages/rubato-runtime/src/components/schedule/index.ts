import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

import {
  ScheduleError,
  createScheduleStore,
  describeSchedule,
  findTask,
  previewSchedule,
  type Run,
  type ScheduleStore,
  type TaskView,
} from "@rubato/schedule-core"
import { Type, type Static } from "typebox"

import type { ComponentContext, RubatoComponent, SenpiExtensionAPI } from "../../extension/types"

// Any Rubato session (CLI or app) can register, list, edit, delete and start scheduled tasks
// from what the user says (user, thread 01a0eab7 item 2f0064f5). The tool writes the same store
// the settings page and `rubato schedule` use; the resident scheduler runs the tasks.

export const SCHEDULE_TOOL_NAME = "schedule"

const ScheduleShape = Type.Object({
  kind: Type.Union([
    Type.Literal("daily"),
    Type.Literal("weekdays"),
    Type.Literal("weekly"),
    Type.Literal("interval"),
    Type.Literal("once"),
  ]),
  time: Type.Optional(Type.String({ description: "24-hour HH:MM local time (daily, weekdays, weekly, once)" })),
  days: Type.Optional(Type.Array(Type.String(), { description: "weekly: mon tue wed thu fri sat sun" })),
  everyHours: Type.Optional(Type.Number({ description: "interval: 1, 2, 3, 4, 6 or 12" })),
  window: Type.Optional(Type.Object({ start: Type.String(), end: Type.String() }, { description: "interval: optional same-day active hours, HH:MM" })),
  date: Type.Optional(Type.String({ description: "once: YYYY-MM-DD" })),
})

export const ScheduleToolParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("delete"),
    Type.Literal("run_now"),
    Type.Literal("history"),
    Type.Literal("preview"),
  ]),
  task: Type.Optional(Type.String({ description: "Existing task's name or id (update, delete, run_now, history)" })),
  name: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String({ description: "First user message of each run's session" })),
  cwd: Type.Optional(Type.String({ description: "Project folder; defaults to this session's folder" })),
  model: Type.Optional(Type.String({ description: "provider/model; omit for the user's default model (empty string clears it)" })),
  thinking: Type.Optional(Type.String({ description: "off minimal low medium high xhigh max; empty string clears it" })),
  enabled: Type.Optional(Type.Boolean()),
  schedule: Type.Optional(ScheduleShape),
})
export type ScheduleToolInput = Static<typeof ScheduleToolParams>

export const SCHEDULE_TOOL_DESCRIPTION = [
  "Manages Rubato scheduled tasks: at a chosen local time, the scheduler on this Mac starts an ordinary session in a folder with a prompt and runs it unattended. Each run appears as its own thread in the app.",
  "",
  "Schedules are one of five kinds: daily {time}, weekdays {time} (Mon–Fri), weekly {days, time}, interval {everyHours: 1|2|3|4|6|12, window?: {start, end}} and once {date, time}. Times are 24-hour HH:MM in the Mac's local time.",
  "Only these five kinds exist. For any other cadence (monthly, day-of-month, every N days or minutes, cron), offer the nearest of them (e.g. monthly → weekly on one weekday, or a once task per date; every 30 minutes → every hour) and ask before registering. When a call is refused, the tool names the closest supported schedule.",
  "Missed times (the Mac asleep or off) are skipped; the settings page and `run_now` can start a skipped task.",
  "",
  "create needs name, prompt and schedule; cwd defaults to this session's folder and model to the user's default (set model only when the user names one). update changes only the fields given. delete removes the task and its history and keeps its past sessions.",
].join("\n")

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }

const SKIP_REASON: Record<string, string> = {
  sleep: "the Mac was asleep",
  "not-running": "didn't run (Mac off or scheduler not running)",
  overlap: "the previous run was still going",
}

function describeRun(run: Run | null): string {
  if (!run) return "never ran"
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "")
  const when = run.scheduledFor ? at(run.scheduledFor) : `manual, ${at(run.startedAt ?? run.finishedAt)}`
  if (run.status === "skipped") {
    return `skipped${run.skipCount > 1 ? ` ×${run.skipCount} (${at(run.scheduledFor)} – ${at(run.lastScheduledFor)})` : ` (${when})`}: ${SKIP_REASON[run.reason ?? ""] ?? run.reason}`
  }
  if (run.status === "failed") return `failed (${when}): ${run.reason}${run.detail ? ` — ${run.detail}` : ""}`
  return `${run.status} (${when})${run.sessionId ? `, session ${run.sessionId}` : ""}`
}

function describeTask(task: TaskView): string {
  return [
    `${task.name} [id ${task.id}] — ${task.enabled ? "on" : "off"}`,
    `  schedule: ${task.summary}; next run: ${task.enabled ? (task.nextRunLabel ?? "none") : "off"}${task.nextRunAt ? ` (${task.nextRunAt})` : ""}`,
    `  folder: ${task.cwd}`,
    `  model: ${task.model ?? "user's default model"}${task.thinking ? `, thinking ${task.thinking}` : ""}`,
    `  prompt: ${task.prompt.length > 200 ? `${task.prompt.slice(0, 200)}…` : task.prompt}`,
    `  last run: ${task.running ? "running now" : describeRun(task.lastRun)}`,
  ].join("\n")
}

const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details })
const refuse = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details, isError: true })

function refusal(error: ScheduleError): ToolResult {
  const closest = error.closest ? ` Closest supported schedule: ${describeSchedule(error.closest)} (${JSON.stringify(error.closest)}). Ask the user before using it.` : ""
  return refuse(`${error.message}${closest}`, { error: error.toJSON() })
}

function resolveFolder(value: string | undefined, sessionCwd: string): string {
  if (value === undefined || value.trim() === "") return sessionCwd
  const trimmed = value.trim()
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(sessionCwd, trimmed)
}

const schedulerNote = (store: ScheduleStore): string => (store.schedulerStatus().running
  ? ""
  : "\nNote: the scheduler is not running on this Mac, so tasks will not run until it is started (`rubato schedule install`).")

export async function runScheduleTool(store: ScheduleStore, params: ScheduleToolInput, sessionCwd: string): Promise<ToolResult> {
  try {
    const fields = () => ({
      ...(params.name === undefined ? {} : { name: params.name }),
      ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.thinking === undefined ? {} : { thinking: params.thinking as never }),
      ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
      ...(params.schedule === undefined ? {} : { schedule: params.schedule as never }),
    })
    const target = async () => findTask((await store.list()).tasks, params.task)
    switch (params.action) {
      case "list": {
        const { tasks } = await store.list()
        return ok(tasks.length ? tasks.map(describeTask).join("\n\n") + schedulerNote(store) : `No scheduled tasks yet.${schedulerNote(store)}`, { tasks })
      }
      case "preview": {
        const preview = previewSchedule(params.schedule)
        return ok(`${preview.summary}; next run: ${preview.nextRunLabel ?? "none"}${preview.nextRunAt ? ` (${preview.nextRunAt})` : ""}`, { preview })
      }
      case "create": {
        const task = await store.create({ ...fields(), cwd: resolveFolder(params.cwd, sessionCwd) } as never)
        return ok(`Registered:\n${describeTask(task)}${schedulerNote(store)}`, { task })
      }
      case "update": {
        const current = await target()
        const task = await store.update(current.id, { ...fields(), ...(params.cwd === undefined ? {} : { cwd: resolveFolder(params.cwd, sessionCwd) }) })
        return ok(`Updated:\n${describeTask(task)}${schedulerNote(store)}`, { task })
      }
      case "delete": {
        const current = await target()
        await store.remove(current.id)
        return ok(`Deleted "${current.name}" and its run history. Sessions it already created are kept.`, { deleted: current.id })
      }
      case "run_now": {
        const current = await target()
        const result = await store.runNow(current.id)
        return ok(`Started "${current.name}" now. It runs as a new session in ${current.cwd}.`, { taskId: current.id, ...result })
      }
      case "history": {
        const current = await target()
        const { runs } = await store.runs(current.id, { limit: 20 })
        return ok(`${current.name}:\n${runs.map((run) => `- ${describeRun(run)}`).join("\n") || "- no runs yet"}`, { taskId: current.id, runs })
      }
      default:
        return refuse(`Unknown action "${String((params as { action?: unknown }).action)}".`)
    }
  } catch (error) {
    if (error instanceof ScheduleError) return refusal(error)
    throw error
  }
}

export interface ScheduleComponentOptions {
  readonly resolveCwd?: () => string
  readonly createStore?: () => ScheduleStore
}

export function createScheduleComponent(options: ScheduleComponentOptions = {}): RubatoComponent {
  const resolveCwd = options.resolveCwd ?? (() => process.cwd())
  const createStore = options.createStore ?? (() => createScheduleStore())
  return {
    name: "schedule",
    register(pi: SenpiExtensionAPI, _ctx: ComponentContext): void {
      pi.registerTool({
        name: SCHEDULE_TOOL_NAME,
        label: "Scheduled tasks",
        description: SCHEDULE_TOOL_DESCRIPTION,
        promptSnippet: "schedule - register/list/edit/delete/run Rubato scheduled tasks (daily, weekdays, weekly, every N hours, once; local time; no cron)",
        promptGuidelines: [
          "When the user asks for work to happen at a time or repeatedly (\"every morning at 9…\"), use the schedule tool; after registering, tell the user the schedule sentence, next run, folder and model it returned.",
        ],
        parameters: ScheduleToolParams,
        // Always visible: a request like "every morning at 9" names no tool to search for.
        exposure: "direct",
        executionMode: "sequential",
        execute: async (_toolCallId: string, params: ScheduleToolInput) => runScheduleTool(createStore(), params, pi.cwd ?? resolveCwd()),
      })
    },
  }
}
