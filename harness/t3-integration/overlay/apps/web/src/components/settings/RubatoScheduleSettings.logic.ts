import type {
  RunStatus,
  Schedule,
  ScheduledTask,
  ScheduleKind,
  ScheduleRun,
  TaskInput,
  Weekday,
} from "../../state/rubatoSchedule";

// Every word this page shows lives in COPY, so its language is one file's change.
// The schedule sentence and the next-run label are not here: they come from
// @rubato/schedule-core, the one place the session tool and the CLI also use.
export const COPY = {
  sectionTasks: "Tasks",
  newTask: "New task",
  refresh: "Refresh",
  loading: "Loading scheduled tasks",
  loadFailed: "Could not load scheduled tasks",
  schedulerOff: "The scheduler is not running",
  schedulerOffBody:
    "Tasks will not start and missed times are recorded as skipped. Run `rubato schedule install` in a terminal to start it.",
  emptyTitle: "No scheduled tasks yet",
  emptyBody:
    "A scheduled task starts a normal Rubato session in a project at the times you pick. Its sessions show up in the sidebar, where you can read and continue them.",
  emptyHint: "You can also ask in any session, like “every weekday at 9 AM, check this repo’s dependencies”.",
  kinds: {
    daily: "Every day",
    weekdays: "Weekdays",
    weekly: "Pick days",
    interval: "Every few hours",
    once: "Once",
  } satisfies Record<ScheduleKind, string>,
  fields: {
    name: "Name",
    namePlaceholder: "Morning research digest",
    project: "Project folder",
    projectHint: "The session runs in this folder.",
    chooseProject: "Choose a project",
    otherFolder: "Other folder…",
    browse: "Choose…",
    folderPlaceholder: "/Users/you/project",
    prompt: "Prompt",
    promptHint: "Sent as the session’s first message.",
    promptPlaceholder: "Summarize what changed in this repo since yesterday.",
    model: "Model",
    modelHint: "Default follows your default model at the time it runs.",
    defaultModel: "Default model",
    thinking: "Reasoning",
    defaultThinking: "Model default",
    schedule: "Schedule",
    time: "Time",
    days: "Days",
    every: "Every",
    hours: (n: number) => (n === 1 ? "hour" : `${n} hours`),
    window: "Only between",
    windowTo: "and",
    date: "Date",
  },
  nextRun: "Next run",
  noNextRun: "Not scheduled",
  off: "Off",
  save: "Save",
  create: "Create task",
  cancel: "Cancel",
  back: "Scheduled Tasks",
  editTitle: "Edit task",
  createTitle: "New task",
  menu: { edit: "Edit", runNow: "Run now", delete: "Delete" },
  taskOptions: (name: string) => `${name} options`,
  enabledLabel: (name: string) => `Run ${name} on schedule`,
  deleteConfirm: (name: string) =>
    `Delete “${name}”? Its run history goes too. Sessions it already started stay in the sidebar.`,
  deleted: (name: string) => `Deleted ${name}`,
  started: (name: string) => `Starting ${name}`,
  startedBody: "Its session shows up in the sidebar in a few seconds.",
  history: "Run history",
  historyEmpty: "No runs yet.",
  historyLoading: "Loading runs",
  manual: "Manual run",
  never: "Never run",
  status: {
    running: "Running",
    success: "Succeeded",
    failed: "Failed",
    skipped: "Skipped",
  } satisfies Record<RunStatus, string>,
  openThread: "Open thread",
  retry: "Retry",
  runNow: "Run now",
  threadPending: "This session is not in the sidebar yet. Try again in a few seconds.",
  reasons: {
    sleep: "Mac was asleep",
    "not-running": "Didn’t run (Mac off or scheduler not running)",
    overlap: "Previous run was still going",
    "cwd-missing": "Project folder is missing",
    "engine-unavailable": "Rubato engine was not available",
    "start-failed": "Session could not start",
    model: "Model could not be used",
    "turn-error": "The session ended with an error",
    aborted: "Stopped",
    interrupted: "Interrupted",
  } as Record<string, string>,
  errors: {
    name: "Give the task a name.",
    cwd: "Choose the project folder.",
    cwdAbsolute: "Use a full path, starting with /.",
    prompt: "Write what the session should do.",
    days: "Pick at least one day.",
    time: "Pick a time.",
    date: "Pick a date.",
    window: "The end has to be after the start, on the same day.",
  },
  saveFailed: "Could not save the task",
  toggleFailed: "Could not change the task",
  runFailed: "Could not start the task",
  deleteFailed: "Could not delete the task",
  threadFailed: "Could not open the thread",
} as const;

export const EVERY_HOURS = [1, 2, 3, 4, 6, 12] as const;
export const WEEK: ReadonlyArray<{ day: Weekday; label: string }> = [
  { day: "mon", label: "Mon" },
  { day: "tue", label: "Tue" },
  { day: "wed", label: "Wed" },
  { day: "thu", label: "Thu" },
  { day: "fri", label: "Fri" },
  { day: "sat", label: "Sat" },
  { day: "sun", label: "Sun" },
];
const JS_DAY: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface TaskForm {
  readonly name: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly kind: ScheduleKind;
  readonly time: string;
  readonly days: readonly Weekday[];
  readonly everyHours: number;
  readonly windowOn: boolean;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly date: string;
}

export type FormField = "name" | "cwd" | "prompt" | "model" | "thinking" | "days" | "time" | "date" | "window" | "schedule";
export type FormErrors = Partial<Record<FormField, string>>;

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function emptyForm(now: Date, cwd = ""): TaskForm {
  const soon = new Date(now.getTime() + 60 * 60_000);
  return {
    name: "",
    cwd,
    prompt: "",
    model: null,
    thinking: null,
    kind: "daily",
    time: "09:00",
    days: [JS_DAY[now.getDay()]!],
    everyHours: 2,
    windowOn: false,
    windowStart: "09:00",
    windowEnd: "18:00",
    date: localDate(soon),
  };
}

/** The form for an existing task; inputs its schedule kind does not use keep their defaults. */
export function formFromTask(task: ScheduledTask, now: Date): TaskForm {
  const base: TaskForm = {
    ...emptyForm(now, task.cwd),
    name: task.name,
    prompt: task.prompt,
    model: task.model,
    thinking: task.thinking,
  };
  const schedule = task.schedule;
  switch (schedule.kind) {
    case "daily":
    case "weekdays":
      return { ...base, kind: schedule.kind, time: schedule.time };
    case "weekly":
      return { ...base, kind: "weekly", time: schedule.time, days: [...schedule.days] };
    case "interval":
      return {
        ...base,
        kind: "interval",
        everyHours: schedule.everyHours,
        windowOn: Boolean(schedule.window),
        windowStart: schedule.window?.start ?? base.windowStart,
        windowEnd: schedule.window?.end ?? base.windowEnd,
      };
    case "once":
      return { ...base, kind: "once", date: schedule.date, time: schedule.time };
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The schedule the form describes, for the live preview; null while its inputs are incomplete. */
export function scheduleFromForm(form: TaskForm): Schedule | null {
  switch (form.kind) {
    case "daily":
    case "weekdays":
      return TIME.test(form.time) ? { kind: form.kind, time: form.time } : null;
    case "weekly": {
      if (!TIME.test(form.time) || form.days.length === 0) return null;
      const days = WEEK.map((entry) => entry.day).filter((day) => form.days.includes(day));
      return { kind: "weekly", days, time: form.time };
    }
    case "interval":
      if (!form.windowOn) return { kind: "interval", everyHours: form.everyHours };
      if (!TIME.test(form.windowStart) || !TIME.test(form.windowEnd) || form.windowEnd <= form.windowStart)
        return null;
      return {
        kind: "interval",
        everyHours: form.everyHours,
        window: { start: form.windowStart, end: form.windowEnd },
      };
    case "once":
      return DATE.test(form.date) && TIME.test(form.time)
        ? { kind: "once", date: form.date, time: form.time }
        : null;
  }
}

/** What the page can tell before asking the service; the service checks the rest (folder exists, time not past). */
export function validateForm(form: TaskForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = COPY.errors.name;
  const cwd = form.cwd.trim();
  if (!cwd) errors.cwd = COPY.errors.cwd;
  else if (!cwd.startsWith("/")) errors.cwd = COPY.errors.cwdAbsolute;
  if (!form.prompt.trim()) errors.prompt = COPY.errors.prompt;
  if (form.kind === "weekly" && form.days.length === 0) errors.days = COPY.errors.days;
  if (form.kind !== "interval" && !TIME.test(form.time)) errors.time = COPY.errors.time;
  if (form.kind === "once" && !DATE.test(form.date)) errors.date = COPY.errors.date;
  if (form.kind === "interval" && form.windowOn && !(form.windowEnd > form.windowStart))
    errors.window = COPY.errors.window;
  return errors;
}

/** What goes to the service; null while the form has errors. */
export function inputFromForm(form: TaskForm): TaskInput | null {
  if (Object.keys(validateForm(form)).length > 0) return null;
  const schedule = scheduleFromForm(form);
  if (!schedule) return null;
  return {
    name: form.name.trim(),
    cwd: form.cwd.trim(),
    prompt: form.prompt.trim(),
    model: form.model,
    thinking: form.model ? form.thinking : null,
    schedule,
  };
}

/** The service names fields like `schedule.time`; the form shows them under its own inputs. */
export function formFieldOf(field: string | undefined): FormField | null {
  if (!field) return null;
  const leaf = field.startsWith("schedule.") ? field.slice("schedule.".length) : field;
  switch (leaf) {
    case "name":
    case "cwd":
    case "prompt":
    case "model":
    case "thinking":
    case "days":
    case "time":
    case "date":
    case "window":
    case "schedule":
      return leaf;
    case "everyHours":
      return "schedule";
    default:
      return null;
  }
}

// ── Run history ─────────────────────────────────────────────────────────────

/** Why a run was skipped or failed, in the words of what the scheduler observed. */
export function reasonLabel(run: ScheduleRun): string | null {
  if (!run.reason) return null;
  return COPY.reasons[run.reason] ?? run.reason;
}

/**
 * What a history row offers. A thread only when a session exists — a run that
 * failed before starting one has nothing to open. A rerun after a failure or skip.
 */
export function runActions(run: ScheduleRun): { openThread: boolean; rerun: "retry" | "run-now" | null } {
  const openThread = run.sessionId !== null && run.status !== "skipped";
  const rerun = run.status === "failed" ? "retry" : run.status === "skipped" ? "run-now" : null;
  return { openThread, rerun };
}

export function durationLabel(run: ScheduleRun, nowMs: number): string | null {
  if (!run.startedAt) return null;
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : run.status === "running" ? nowMs : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

/** When a past run happened: “Today 9:00 AM”, “Yesterday 9:00 AM”, “Wed, Sep 24 9:00 AM”. */
export function whenLabel(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  const time = timeFormat.format(date);
  if (days === 0) return `Today ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return `${dayFormat.format(date)} ${time}`;
}

/** The row's time: its slot, a folded skip's span, or the start of a manual run. */
export function runTimeLabel(run: ScheduleRun, now: Date): string {
  if (run.status === "skipped" && run.skipCount > 1 && run.scheduledFor && run.lastScheduledFor) {
    const from = new Date(run.scheduledFor);
    const to = new Date(run.lastScheduledFor);
    return from.toDateString() === to.toDateString()
      ? `${whenLabel(run.scheduledFor, now)}–${timeFormat.format(to)}`
      : `${whenLabel(run.scheduledFor, now)} – ${whenLabel(run.lastScheduledFor, now)}`;
  }
  return whenLabel(run.scheduledFor ?? run.startedAt, now);
}

/** “Skipped”, or “Skipped ×4” for a row that folds several missed times. */
export function statusLabel(run: ScheduleRun): string {
  const label = COPY.status[run.status];
  return run.status === "skipped" && run.skipCount > 1 ? `${label} ×${run.skipCount}` : label;
}

export type BadgeVariant = "info" | "success" | "error" | "warning" | "secondary";
export const STATUS_BADGE: Record<RunStatus, BadgeVariant> = {
  running: "info",
  success: "success",
  failed: "error",
  skipped: "warning",
};

/** Tilde form of a folder under the home folder. */
export function tildePath(value: string, home: string | null): string {
  return home && (value === home || value.startsWith(`${home}/`)) ? `~${value.slice(home.length)}` : value;
}
