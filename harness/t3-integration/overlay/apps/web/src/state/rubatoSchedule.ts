import type { EnvironmentId } from "@t3tools/contracts";

import { postRubato } from "./rubatoHttp";

/** The route Rubato adds to the T3 server on this Mac for Settings > Scheduled Tasks. */
const SCHEDULE_ROUTE = "/rubato/schedule";

// Shapes follow @rubato/schedule-core (packages/schedule-core/src/index.d.ts).

export type ScheduleKind = "daily" | "weekdays" | "weekly" | "interval" | "once";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** When a task runs. Chosen, never typed as a cron expression. Times are the Mac's local time. */
export type Schedule =
  | { readonly kind: "daily"; readonly time: string }
  | { readonly kind: "weekdays"; readonly time: string }
  | { readonly kind: "weekly"; readonly days: readonly Weekday[]; readonly time: string }
  | {
      readonly kind: "interval";
      readonly everyHours: number;
      readonly window?: { readonly start: string; readonly end: string };
    }
  | { readonly kind: "once"; readonly date: string; readonly time: string };

export type RunStatus = "running" | "success" | "failed" | "skipped";

export interface ScheduleRun {
  readonly id: string;
  readonly taskId: string;
  readonly trigger: "schedule" | "manual";
  /** The slot it was scheduled for; null for a manual run. */
  readonly scheduledFor: string | null;
  /** The last slot a folded skip row covers. */
  readonly lastScheduledFor: string | null;
  /** How many slots a skip row covers; 0 otherwise. */
  readonly skipCount: number;
  readonly status: RunStatus;
  /** A code. Skips: sleep | not-running | overlap. Failures: cwd-missing | engine-unavailable | start-failed | model | turn-error | aborted | interrupted. */
  readonly reason: string | null;
  /** The failure's own short text. */
  readonly detail: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly cwd: string;
  /** Null when the run failed before a session existed. */
  readonly sessionId: string | null;
  readonly serverId: string | null;
  readonly title: string | null;
  readonly rerunOf: string | null;
}

export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly prompt: string;
  /** "provider/id" as T3 lists Rubato models; null: the user's default model when it runs. */
  readonly model: string | null;
  readonly thinking: string | null;
  readonly schedule: Schedule;
  readonly enabled: boolean;
  /** The shared sentence for the schedule ("Every day at 9:00 AM"). */
  readonly summary: string;
  readonly nextRunAt: string | null;
  /** The shared label for nextRunAt ("Tomorrow at 9:00 AM"), as of the list call. */
  readonly nextRunLabel: string | null;
  readonly lastRun: ScheduleRun | null;
  readonly running: boolean;
}

export interface SchedulerState {
  readonly running: boolean;
  readonly pid: number | null;
  readonly lastTickAt: string | null;
}

export interface TaskInput {
  readonly name: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly schedule: Schedule;
  readonly enabled?: boolean;
}

export interface SchedulePreview {
  readonly summary: string;
  readonly nextRunAt: string | null;
  readonly nextRunLabel: string | null;
}

export interface TaskList {
  readonly revision: number;
  readonly scheduler: SchedulerState;
  readonly tasks: ScheduledTask[];
  /** The Mac's home folder, to show paths as ~/…. */
  readonly home: string | null;
}

const call = <T>(env: EnvironmentId | null, action: string, body: Record<string, unknown> = {}) =>
  postRubato<T>(env, SCHEDULE_ROUTE, action, body, "scheduled tasks");

export const rubatoSchedule = {
  list: (env: EnvironmentId | null) => call<TaskList>(env, "list"),
  /** A cheap number that changes with every write; poll it and refetch on change. */
  revision: (env: EnvironmentId | null) => call<{ revision: number }>(env, "revision"),
  runs: (env: EnvironmentId | null, taskId: string) =>
    call<{ revision: number; runs: ScheduleRun[] }>(env, "runs", { taskId }),
  create: (env: EnvironmentId | null, task: TaskInput) => call<ScheduledTask>(env, "create", { task }),
  update: (env: EnvironmentId | null, taskId: string, patch: Partial<TaskInput>) =>
    call<ScheduledTask>(env, "update", { taskId, patch }),
  setEnabled: (env: EnvironmentId | null, taskId: string, enabled: boolean) =>
    call<ScheduledTask>(env, "set-enabled", { taskId, enabled }),
  remove: (env: EnvironmentId | null, taskId: string) => call<{ deleted: true }>(env, "delete", { taskId }),
  runNow: (env: EnvironmentId | null, taskId: string, fromRunId?: string) =>
    call<{ requestId: string }>(env, "run-now", fromRunId ? { taskId, fromRunId } : { taskId }),
  preview: (env: EnvironmentId | null, schedule: Schedule) =>
    call<SchedulePreview>(env, "preview", { schedule }),
  /** Installs the scheduler's launchd agent if needed and starts it; resolves once it runs. */
  startScheduler: (env: EnvironmentId | null) =>
    call<{ scheduler: SchedulerState }>(env, "start-scheduler"),
  /** The T3 thread a run's session shows as; null while the app has not picked it up yet. */
  thread: (env: EnvironmentId | null, sessionId: string, serverId: string | null) =>
    call<{ threadId: string | null }>(env, "thread", { sessionId, serverId }),
};
