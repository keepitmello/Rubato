import { ScheduleError } from './errors.mjs';

// Schedules are picked, never typed as cron (user, thread 01a0eab7 item 2f0064f5). Five
// kinds, all in the Mac's local time zone. Everything that turns a schedule into instants
// or words lives here so the settings page, the session tool and the CLI say the same thing.

export const SCHEDULE_KINDS = Object.freeze(['daily', 'weekdays', 'weekly', 'interval', 'once']);
export const INTERVAL_HOURS = Object.freeze([1, 2, 3, 4, 6, 12]);
export const DAY_NAMES = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// JS getDay(): 0 = Sunday.
const JS_DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const unsupported = (message, closest, field = 'schedule') =>
  new ScheduleError('schedule-unsupported', message, { field, ...(closest ? { closest } : {}) });
const invalid = (message, field) => new ScheduleError('invalid', message, { field });

function parseTime(value, field) {
  const match = typeof value === 'string' ? TIME.exec(value.trim()) : null;
  if (!match) throw invalid('Use a time like 09:00 (24-hour HH:MM).', field);
  return `${match[1]}:${match[2]}`;
}
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

function nearestHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return INTERVAL_HOURS.reduce((best, h) => (Math.abs(h - n) < Math.abs(best - n) ? h : best), INTERVAL_HOURS[0]);
}

/**
 * Checks and normalizes a schedule. Unknown kinds, cron text and values outside the picker
 * are refused with `schedule-unsupported` and, where one exists, the closest representable
 * schedule. `now` only matters for `once` (a time already past is refused).
 */
export function validateSchedule(input, { now = new Date() } = {}) {
  if (typeof input === 'string') {
    throw unsupported('Schedules are picked, not typed: choose daily, weekdays, weekly, every N hours or once.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('A schedule is required.', 'schedule');
  if ('cron' in input || 'expression' in input) {
    throw unsupported('Cron expressions are not supported. Choose daily, weekdays, weekly, every N hours or once.');
  }
  switch (input.kind) {
    case 'daily':
    case 'weekdays':
      return { kind: input.kind, time: parseTime(input.time, 'schedule.time') };
    case 'weekly': {
      const time = parseTime(input.time, 'schedule.time');
      if (!Array.isArray(input.days) || input.days.length === 0) throw invalid('Pick at least one day.', 'schedule.days');
      const days = [...new Set(input.days.map((day) => String(day).trim().toLowerCase().slice(0, 3)))];
      const unknown = days.find((day) => !DAY_NAMES.includes(day));
      if (unknown) throw invalid(`Unknown day "${unknown}". Use mon, tue, wed, thu, fri, sat or sun.`, 'schedule.days');
      return { kind: 'weekly', days: DAY_NAMES.filter((day) => days.includes(day)), time };
    }
    case 'interval': {
      const everyHours = Number(input.everyHours);
      if (!INTERVAL_HOURS.includes(everyHours)) {
        const closest = { kind: 'interval', everyHours: nearestHours(input.everyHours),
          ...(input.window ? { window: input.window } : {}) };
        throw unsupported(`Every ${input.everyHours ?? '?'} hours is not available. Choose every 1, 2, 3, 4, 6 or 12 hours.`,
          closest, 'schedule.everyHours');
      }
      if (input.window === undefined || input.window === null) return { kind: 'interval', everyHours };
      const start = parseTime(input.window?.start, 'schedule.window');
      const end = parseTime(input.window?.end, 'schedule.window');
      if (minutesOf(start) >= minutesOf(end)) {
        throw unsupported('The active hours must start and end on the same day (start before end).',
          { kind: 'interval', everyHours }, 'schedule.window');
      }
      return { kind: 'interval', everyHours, window: { start, end } };
    }
    case 'once': {
      const time = parseTime(input.time, 'schedule.time');
      const match = typeof input.date === 'string' ? DATE.exec(input.date.trim()) : null;
      const [year, month, day] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
      const probe = match && new Date(year, month - 1, day);
      if (!probe || probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
        throw invalid('Use a date like 2026-09-30.', 'schedule.date');
      }
      const schedule = { kind: 'once', date: `${match[1]}-${match[2]}-${match[3]}`, time };
      if (onceAt(schedule).getTime() <= now.getTime()) {
        throw new ScheduleError('schedule-in-past', 'That date and time has already passed.', { field: 'schedule.date' });
      }
      return schedule;
    }
    default:
      throw unsupported(`Unknown schedule kind "${input.kind}". Choose daily, weekdays, weekly, interval (every N hours) or once.`);
  }
}

function atWallClock(year, month, day, minutes) {
  return new Date(year, month, day, Math.floor(minutes / 60), minutes % 60, 0, 0);
}
function onceAt(schedule) {
  const [year, month, day] = schedule.date.split('-').map(Number);
  return atWallClock(year, month - 1, day, minutesOf(schedule.time));
}

/** Wall-clock times (minutes after local midnight) the schedule fires on a given local day. */
function minutesOnDay(schedule, dayOfWeek) {
  switch (schedule.kind) {
    case 'daily': return [minutesOf(schedule.time)];
    case 'weekdays': return dayOfWeek >= 1 && dayOfWeek <= 5 ? [minutesOf(schedule.time)] : [];
    case 'weekly': return schedule.days.some((day) => JS_DAY[day] === dayOfWeek) ? [minutesOf(schedule.time)] : [];
    case 'interval': {
      const start = schedule.window ? minutesOf(schedule.window.start) : 0;
      const end = schedule.window ? minutesOf(schedule.window.end) : 24 * 60 - 1;
      const result = [];
      for (let minutes = start; minutes <= end; minutes += schedule.everyHours * 60) result.push(minutes);
      return result;
    }
    default: return [];
  }
}

/**
 * Every instant in (from, to], oldest first. Wall-clock math: a time a DST jump skips runs at
 * the instant `Date` moves it to; a repeated wall-clock time runs once. Duplicates collapse.
 */
export function occurrencesBetween(schedule, from, to) {
  const start = from.getTime();
  const end = to.getTime();
  if (!(end > start)) return [];
  if (schedule.kind === 'once') {
    const at = onceAt(schedule).getTime();
    return at > start && at <= end ? [new Date(at)] : [];
  }
  const seen = new Set();
  const result = [];
  // Start one local day early: a DST shift can move the first candidate across midnight.
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  while (cursor.getTime() <= end + DAY_MS) {
    for (const minutes of minutesOnDay(schedule, cursor.getDay())) {
      const at = atWallClock(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), minutes).getTime();
      if (at > start && at <= end && !seen.has(at)) { seen.add(at); result.push(at); }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return result.sort((a, b) => a - b).map((at) => new Date(at));
}

/** The first instant strictly after `after`, or null (a once-schedule already behind). */
export function nextRunAfter(schedule, after = new Date()) {
  if (schedule.kind === 'once') {
    const at = onceAt(schedule);
    return at.getTime() > after.getTime() ? at : null;
  }
  // Every recurring kind fires at least once in any 8 local days.
  const horizon = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 9);
  return occurrencesBetween(schedule, after, horizon)[0] ?? null;
}

export function formatClock(minutesOrDate) {
  const minutes = minutesOrDate instanceof Date ? minutesOrDate.getHours() * 60 + minutesOrDate.getMinutes() : minutesOrDate;
  const hour = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, '0');
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}
const monthDay = (date, now) => `${MONTH_LABEL[date.getMonth()]} ${date.getDate()}${date.getFullYear() === now.getFullYear() ? '' : `, ${date.getFullYear()}`}`;

/** The one sentence every surface shows for a schedule (English; the settings page is English). */
export function describeSchedule(schedule, { now = new Date() } = {}) {
  switch (schedule.kind) {
    case 'daily': return `Every day at ${formatClock(minutesOf(schedule.time))}`;
    case 'weekdays': return `Weekdays (Mon–Fri) at ${formatClock(minutesOf(schedule.time))}`;
    case 'weekly': {
      const days = schedule.days;
      const label = days.length === 7 ? 'day' : days.length === 5 && WEEKDAYS.every((day) => days.includes(day))
        ? 'Mon–Fri' : days.map((day) => DAY_LABEL[day]).join(', ');
      return `Every ${label} at ${formatClock(minutesOf(schedule.time))}`;
    }
    case 'interval': {
      const every = schedule.everyHours === 1 ? 'Every hour' : `Every ${schedule.everyHours} hours`;
      return schedule.window ? `${every} (${schedule.window.start}–${schedule.window.end})` : every;
    }
    case 'once': return `Once on ${monthDay(onceAt(schedule), now)} at ${formatClock(minutesOf(schedule.time))}`;
    default: return 'Unknown schedule';
  }
}

/** "Today at 3:00 PM", "Tomorrow at 9:00 AM", "Tue, Sep 30 at 9:00 AM". */
export function formatNextRun(date, now = new Date()) {
  if (!date) return null;
  const at = new Date(date);
  const dayIndex = (value) => Math.round(new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime() / DAY_MS);
  const delta = dayIndex(at) - dayIndex(now);
  const clock = formatClock(at);
  if (delta === 0) return `Today at ${clock}`;
  if (delta === 1) return `Tomorrow at ${clock}`;
  return `${DAY_LABEL[DAY_NAMES[(at.getDay() + 6) % 7]]}, ${monthDay(at, now)} at ${clock}`;
}

/** Live preview for a form: the sentence and the next instant, or the validation error thrown. */
export function previewSchedule(input, { now = new Date() } = {}) {
  const schedule = validateSchedule(input, { now });
  const next = nextRunAfter(schedule, now);
  return { schedule, summary: describeSchedule(schedule, { now }), nextRunAt: next?.toISOString() ?? null,
    nextRunLabel: formatNextRun(next, now) };
}
