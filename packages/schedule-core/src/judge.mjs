import { occurrencesBetween } from './schedule.mjs';

/** A scheduled time counts as on time up to this long after it (spec §4). */
export const GRACE_MS = 5 * 60_000;
/** Run rows kept per task; a collapsed skip row counts once. */
export const RUNS_KEPT_PER_TASK = 100;

/**
 * What the scheduler does with one enabled task at `now`. Pure: the caller owns the store.
 *
 * - Times in (task.evaluatedThrough, now] are judged once; afterwards the cursor is `now`.
 * - A time within GRACE_MS of now runs, unless the task's previous run is still going
 *   (`overlap`). Only the latest time can be that close; older ones are skipped.
 * - A late time is skipped, never caught up. The reason is only what was observed:
 *   `sleep` when this scheduler process was already alive at that time (so its clock
 *   jumped: the process was suspended), otherwise `not-running`.
 * - A once-schedule is disabled after its one time is judged, whatever the outcome.
 *
 * @returns {{ fire: Date|null, skips: {scheduledFor: Date, reason: string}[], evaluatedThrough: Date, disable: boolean }}
 */
export function judgeTask(task, { now, schedulerStartedAt, running = false, graceMs = GRACE_MS }) {
  const from = task.evaluatedThrough ? new Date(task.evaluatedThrough) : null;
  if (!from || !(from < now)) return { fire: null, skips: [], evaluatedThrough: from && from > now ? from : now, disable: false };
  const due = occurrencesBetween(task.schedule, from, now);
  const skips = [];
  let fire = null;
  due.forEach((at, index) => {
    const late = now.getTime() - at.getTime() > graceMs;
    const latest = index === due.length - 1;
    if (!late && latest) {
      if (running) skips.push({ scheduledFor: at, reason: 'overlap' });
      else fire = at;
      return;
    }
    const observedAlive = schedulerStartedAt !== undefined && schedulerStartedAt !== null
      && new Date(schedulerStartedAt).getTime() <= at.getTime();
    skips.push({ scheduledFor: at, reason: late ? (observedAlive ? 'sleep' : 'not-running') : 'overlap' });
  });
  return { fire, skips, evaluatedThrough: now, disable: task.schedule.kind === 'once' && due.length > 0 };
}

/**
 * Records a skipped time. Consecutive skips of one task for the same reason share a row
 * ("Skipped ×4 · 01:00–07:00"): the task's latest row is extended instead of adding one.
 */
export function recordSkip(runs, { taskId, scheduledFor, reason, cwd, newId, now }) {
  const iso = scheduledFor.toISOString();
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].taskId !== taskId) continue;
    const latest = runs[i];
    if (latest.status === 'skipped' && latest.reason === reason) {
      latest.skipCount += 1;
      latest.lastScheduledFor = iso;
      latest.finishedAt = now.toISOString();
      return latest;
    }
    break;
  }
  const row = { id: newId(), taskId, trigger: 'schedule', scheduledFor: iso, lastScheduledFor: iso, skipCount: 1,
    status: 'skipped', reason, detail: null, startedAt: null, finishedAt: now.toISOString(), model: null, thinking: null,
    cwd, sessionId: null, serverId: null, title: null, rerunOf: null };
  runs.push(row);
  return row;
}

/** Drops a task's oldest rows beyond the retention limit. Never drops a running row. */
export function pruneRuns(runs, limit = RUNS_KEPT_PER_TASK) {
  const counts = new Map();
  const kept = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    const count = (counts.get(run.taskId) ?? 0) + 1;
    counts.set(run.taskId, count);
    if (count <= limit || run.status === 'running') kept.push(run);
  }
  return kept.reverse();
}
