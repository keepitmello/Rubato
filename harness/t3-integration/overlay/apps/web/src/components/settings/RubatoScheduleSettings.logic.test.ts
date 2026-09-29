import { describe, expect, it } from "@effect/vitest";

import type { ScheduledTask, ScheduleRun } from "../../state/rubatoSchedule";
import {
  COPY,
  durationLabel,
  emptyForm,
  formFieldOf,
  formFromTask,
  inputFromForm,
  reasonLabel,
  runActions,
  runTimeLabel,
  scheduleFromForm,
  statusLabel,
  validateForm,
  type TaskForm,
} from "./RubatoScheduleSettings.logic";

const now = new Date(2026, 8, 29, 10, 30); // Tue, Sep 29 2026, 10:30 local

const filled = (patch: Partial<TaskForm> = {}): TaskForm => ({
  ...emptyForm(now),
  name: " Morning digest ",
  cwd: "/code/repo",
  prompt: " Summarize ",
  ...patch,
});

function run(patch: Partial<ScheduleRun>): ScheduleRun {
  return {
    id: "r1",
    taskId: "t1",
    trigger: "schedule",
    scheduledFor: new Date(2026, 8, 29, 9, 0).toISOString(),
    lastScheduledFor: null,
    skipCount: 0,
    status: "success",
    reason: null,
    detail: null,
    startedAt: null,
    finishedAt: null,
    model: null,
    thinking: null,
    cwd: "/code/repo",
    sessionId: null,
    serverId: null,
    title: null,
    rerunOf: null,
    ...patch,
  };
}

describe("schedule form", () => {
  it("starts as a daily 9 AM task with nothing chosen for the user", () => {
    const form = emptyForm(now);
    expect(form.kind).toBe("daily");
    expect(form.time).toBe("09:00");
    expect(form.model).toBeNull();
    expect(form.days).toEqual(["tue"]);
    expect(scheduleFromForm(form)).toEqual({ kind: "daily", time: "09:00" });
  });

  it("sends only the chosen kind's inputs, never a cron expression", () => {
    const base = filled({ time: "07:15", days: ["fri", "mon"], everyHours: 3, date: "2026-10-01" });
    expect(scheduleFromForm({ ...base, kind: "daily" })).toEqual({ kind: "daily", time: "07:15" });
    expect(scheduleFromForm({ ...base, kind: "weekdays" })).toEqual({ kind: "weekdays", time: "07:15" });
    expect(scheduleFromForm({ ...base, kind: "weekly" })).toEqual({
      kind: "weekly",
      days: ["mon", "fri"],
      time: "07:15",
    });
    expect(scheduleFromForm({ ...base, kind: "interval" })).toEqual({ kind: "interval", everyHours: 3 });
    expect(scheduleFromForm({ ...base, kind: "once" })).toEqual({ kind: "once", date: "2026-10-01", time: "07:15" });
  });

  it("adds the active-hours window to an interval only when it is on and in order", () => {
    const base = filled({ kind: "interval", everyHours: 2, windowOn: true, windowStart: "09:00", windowEnd: "18:00" });
    expect(scheduleFromForm(base)).toEqual({
      kind: "interval",
      everyHours: 2,
      window: { start: "09:00", end: "18:00" },
    });
    expect(scheduleFromForm({ ...base, windowEnd: "08:00" })).toBeNull();
    expect(validateForm({ ...base, windowEnd: "08:00" }).window).toBe(COPY.errors.window);
  });

  it("asks for what is missing, under the input it belongs to", () => {
    const errors = validateForm({ ...emptyForm(now), kind: "weekly", days: [], cwd: "repo" });
    expect(Object.keys(errors).toSorted()).toEqual(["cwd", "days", "name", "prompt"]);
    expect(errors.cwd).toBe(COPY.errors.cwdAbsolute);
    expect(inputFromForm({ ...emptyForm(now) })).toBeNull();
  });

  it("trims the text it sends and drops reasoning when the default model is chosen", () => {
    expect(inputFromForm(filled({ model: null, thinking: "high" }))).toEqual({
      name: "Morning digest",
      cwd: "/code/repo",
      prompt: "Summarize",
      model: null,
      thinking: null,
      schedule: { kind: "daily", time: "09:00" },
    });
    expect(inputFromForm(filled({ model: "anthropic/claude-opus-5-5", thinking: "high" }))?.thinking).toBe("high");
  });

  it("round-trips an existing task, keeping defaults for inputs its kind does not use", () => {
    const task: ScheduledTask = {
      id: "t1",
      name: "Deps",
      cwd: "/code/repo",
      prompt: "Check deps",
      model: "openai-codex/gpt-6-sol",
      thinking: "high",
      schedule: { kind: "interval", everyHours: 6, window: { start: "08:00", end: "20:00" } },
      enabled: true,
      summary: "Every 6 hours (08:00–20:00)",
      nextRunAt: null,
      nextRunLabel: null,
      lastRun: null,
      running: false,
    };
    const form = formFromTask(task, now);
    expect(form).toMatchObject({ kind: "interval", everyHours: 6, windowOn: true, windowStart: "08:00", time: "09:00" });
    expect(inputFromForm(form)?.schedule).toEqual(task.schedule);
    expect(formFromTask({ ...task, schedule: { kind: "weekly", days: ["sat", "sun"], time: "10:00" } }, now).days).toEqual([
      "sat",
      "sun",
    ]);
  });

  it("places the service's field errors on the form's inputs", () => {
    expect(formFieldOf("schedule.time")).toBe("time");
    expect(formFieldOf("schedule.days")).toBe("days");
    expect(formFieldOf("schedule.everyHours")).toBe("schedule");
    expect(formFieldOf("cwd")).toBe("cwd");
    expect(formFieldOf(undefined)).toBeNull();
    expect(formFieldOf("somethingElse")).toBeNull();
  });
});

describe("run history", () => {
  it("offers the thread only when the run has a session", () => {
    expect(runActions(run({ status: "success", sessionId: "s1" }))).toEqual({ openThread: true, rerun: null });
    expect(runActions(run({ status: "running", sessionId: "s1" }))).toEqual({ openThread: true, rerun: null });
    // Failed after the session started: open it and retry.
    expect(runActions(run({ status: "failed", reason: "turn-error", sessionId: "s1" }))).toEqual({
      openThread: true,
      rerun: "retry",
    });
    // Failed before any session existed: there is nothing to open.
    expect(runActions(run({ status: "failed", reason: "cwd-missing", sessionId: null }))).toEqual({
      openThread: false,
      rerun: "retry",
    });
    expect(runActions(run({ status: "skipped", reason: "sleep" }))).toEqual({ openThread: false, rerun: "run-now" });
  });

  it("says only what the scheduler observed about a skip", () => {
    expect(reasonLabel(run({ status: "skipped", reason: "sleep" }))).toBe("Mac was asleep");
    expect(reasonLabel(run({ status: "skipped", reason: "not-running" }))).toBe(
      "Didn’t run (Mac off or scheduler not running)",
    );
    expect(reasonLabel(run({ status: "skipped", reason: "overlap" }))).toBe("Previous run was still going");
    expect(reasonLabel(run({ status: "failed", reason: "interrupted" }))).toBe("Interrupted");
    expect(reasonLabel(run({ status: "failed", reason: "brand-new-code" }))).toBe("brand-new-code");
    expect(reasonLabel(run({ status: "success" }))).toBeNull();
  });

  it("shows a folded skip row as a count over its span", () => {
    const folded = run({
      status: "skipped",
      reason: "sleep",
      skipCount: 4,
      scheduledFor: new Date(2026, 8, 29, 1, 0).toISOString(),
      lastScheduledFor: new Date(2026, 8, 29, 7, 0).toISOString(),
    });
    expect(statusLabel(folded)).toBe("Skipped ×4");
    expect(runTimeLabel(folded, now)).toBe("Today 1:00 AM–7:00 AM");
    expect(statusLabel(run({ status: "skipped", skipCount: 1 }))).toBe("Skipped");
  });

  it("times a manual run by its start and a scheduled one by its slot", () => {
    expect(runTimeLabel(run({}), now)).toBe("Today 9:00 AM");
    expect(
      runTimeLabel(
        run({ trigger: "manual", scheduledFor: null, startedAt: new Date(2026, 8, 28, 22, 5).toISOString() }),
        now,
      ),
    ).toBe("Yesterday 10:05 PM");
  });

  it("measures a finished run, and a running one up to now", () => {
    const startedAt = new Date(2026, 8, 29, 9, 0, 0).toISOString();
    expect(durationLabel(run({ startedAt, finishedAt: new Date(2026, 8, 29, 9, 2, 13).toISOString() }), 0)).toBe("2m 13s");
    expect(durationLabel(run({ status: "running", startedAt }), new Date(2026, 8, 29, 9, 0, 42).getTime())).toBe("42s");
    expect(durationLabel(run({ startedAt: null }), 0)).toBeNull();
  });
});
