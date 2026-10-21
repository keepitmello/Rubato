export type DayName = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: DayName[]; time: string }
  | { kind: "interval"; everyHours: 1 | 2 | 3 | 4 | 6 | 12; window?: { start: string; end: string } }
  | { kind: "once"; date: string; time: string }

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
export type SkipReason = "sleep" | "not-running" | "overlap"
export type FailureReason = "cwd-missing" | "engine-unavailable" | "start-failed" | "model" | "turn-error" | "aborted" | "interrupted"
  | "no-target" | "delivery-failed"

/** "companion" (Segno, whichever conversation is its own at the time) or a conversation id. */
export type SendTo = "companion" | (string & {})

export interface Task {
  id: string
  name: string
  /** Null: each run starts a new session in `cwd`. Set: each run sends `prompt` to that conversation, no session. */
  sendTo: SendTo | null
  /** Null for a message task. */
  cwd: string | null
  prompt: string
  model: string | null
  thinking: ThinkingLevel | null
  schedule: Schedule
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface Run {
  id: string
  taskId: string
  trigger: "schedule" | "manual"
  scheduledFor: string | null
  lastScheduledFor: string | null
  skipCount: number
  status: "running" | "success" | "failed" | "skipped"
  reason: SkipReason | FailureReason | null
  detail: string | null
  startedAt: string | null
  finishedAt: string | null
  model: string | null
  thinking: string | null
  cwd: string | null
  /** "message" for a run that sent a message (its sessionId is the conversation it reached); absent for a session run. */
  kind?: "message"
  sessionId: string | null
  serverId: string | null
  title: string | null
  rerunOf: string | null
}

export interface TaskView extends Task {
  summary: string
  nextRunAt: string | null
  nextRunLabel: string | null
  lastRun: Run | null
  running: boolean
}

export interface SchedulerStatus {
  running: boolean
  pid: number | null
  startedAt: string | null
  lastTickAt: string | null
}

export interface TaskInput {
  name: string
  sendTo?: SendTo | null
  cwd?: string | null
  prompt: string
  schedule: Schedule
  model?: string | null
  thinking?: ThinkingLevel | null
  enabled?: boolean
}

export interface SchedulePreview {
  schedule: Schedule
  summary: string
  nextRunAt: string | null
  nextRunLabel: string | null
}

export declare class ScheduleError extends Error {
  constructor(code: ScheduleError["code"], message: string, options?: { field?: string; closest?: Schedule })
  code: "invalid" | "schedule-unsupported" | "schedule-in-past" | "not-found" | "already-running" | "scheduler-offline" | "busy" | "corrupt"
  field?: string
  closest?: Schedule
  toJSON(): { code: string; message: string; field?: string; closest?: Schedule }
}

export interface ScheduleStore {
  readonly files: { root: string; state: string; lock: string; scheduler: string; logs: string }
  list(): Promise<{ revision: number; scheduler: SchedulerStatus; tasks: TaskView[] }>
  get(taskId: string): Promise<TaskView>
  revision(): Promise<number>
  runs(taskId: string, options?: { limit?: number }): Promise<{ revision: number; runs: Run[] }>
  create(input: TaskInput): Promise<TaskView>
  update(taskId: string, patch: Partial<TaskInput>): Promise<TaskView>
  setEnabled(taskId: string, enabled: boolean): Promise<TaskView>
  remove(taskId: string): Promise<{ deleted: true }>
  runNow(taskId: string, options?: { fromRunId?: string | null }): Promise<{ requestId: string }>
  /** One message now, outside any task; the scheduler delivers it. */
  send(message: { to: SendTo; text: string }): Promise<{ requestId: string }>
  preview(schedule: unknown, options?: { now?: Date }): SchedulePreview
  schedulerStatus(): SchedulerStatus
}

export declare const SCHEDULE_KINDS: readonly Schedule["kind"][]
export declare const INTERVAL_HOURS: readonly number[]
export declare const DAY_NAMES: readonly DayName[]
export declare const THINKING_LEVELS: readonly ThinkingLevel[]
export declare const COMPANION_TARGET: "companion"
export declare const MESSAGE_CHARS: number
export declare function validateSendTo(value: unknown): SendTo | null
export declare function validateMessageText(value: unknown): string
export declare const GRACE_MS: number
export declare const RUNS_KEPT_PER_TASK: number
export declare function createScheduleStore(options?: { env?: Record<string, string | undefined>; now?: () => Date; root?: string }): ScheduleStore
export declare function findTask<T extends { id: string; name: string }>(tasks: T[], query: string | undefined): T
export declare function scheduleHome(env?: Record<string, string | undefined>): string
export declare function validateSchedule(input: unknown, options?: { now?: Date }): Schedule
export declare function previewSchedule(input: unknown, options?: { now?: Date }): SchedulePreview
export declare function describeSchedule(schedule: Schedule, options?: { now?: Date }): string
export declare function formatNextRun(date: Date | string | null, now?: Date): string | null
export declare function formatClock(value: number | Date): string
export declare function nextRunAfter(schedule: Schedule, after?: Date): Date | null
export declare function occurrencesBetween(schedule: Schedule, from: Date, to: Date): Date[]
export declare function validateTaskFields(input: unknown, options?: { partial?: boolean; now?: Date; current?: Task }): Partial<TaskInput>
export declare function judgeTask(task: Task & { evaluatedThrough: string | null }, options: {
  now: Date; schedulerStartedAt?: Date | string | null; running?: boolean; graceMs?: number
}): { fire: Date | null; skips: { scheduledFor: Date; reason: SkipReason }[]; evaluatedThrough: Date; disable: boolean }
export declare function recordSkip(runs: Run[], options: {
  taskId: string; scheduledFor: Date; reason: SkipReason; cwd: string | null; newId: () => string; now: Date
}): Run
export declare function pruneRuns(runs: Run[], limit?: number): Run[]
