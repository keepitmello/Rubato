import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { describeSchedule, formatNextRun, nextRunAfter, occurrencesBetween, previewSchedule, validateSchedule,
  ScheduleError } from '../src/index.mjs';

// Local wall-clock math is the point of these tests, so they pin a zone: Seoul (no DST) for
// the ordinary cases, New York for the DST transitions.
const previousTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Asia/Seoul'; });
afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const clock = (date) => `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const between = (schedule, from, to) => occurrencesBetween(validateSchedule(schedule, { now: from }), from, to).map(clock);
const refusal = (fn) => { try { fn(); } catch (error) { return error; } throw new Error('expected a refusal'); };

describe('occurrences per kind (local time)', () => {
  test('daily fires at the local time every day, including across a month end', () => {
    expect(between({ kind: 'daily', time: '09:00' }, local(2026, 1, 30, 10), local(2026, 2, 2, 10)))
      .toEqual(['1/31 09:00', '2/1 09:00', '2/2 09:00']);
    // Stored as a real instant: 09:00 Seoul is 00:00 UTC.
    expect(nextRunAfter(validateSchedule({ kind: 'daily', time: '09:00' }), local(2026, 1, 30, 10)).toISOString())
      .toBe('2026-01-31T00:00:00.000Z');
  });

  test('weekdays skips Saturday and Sunday', () => {
    // 2026-09-25 is a Friday.
    expect(between({ kind: 'weekdays', time: '08:30' }, local(2026, 9, 25, 9), local(2026, 9, 29, 9)))
      .toEqual(['9/28 08:30', '9/29 08:30']);
  });

  test('weekly fires only on the chosen days, whatever order they were given in', () => {
    const schedule = { kind: 'weekly', days: ['fri', 'mon', 'wed'], time: '07:00' };
    expect(validateSchedule(schedule).days).toEqual(['mon', 'wed', 'fri']);
    expect(between(schedule, local(2026, 9, 27, 0), local(2026, 10, 4, 23)))
      .toEqual(['9/28 07:00', '9/30 07:00', '10/2 07:00']);
  });

  test('weekly on Sunday rolls over a month end and a leap day', () => {
    // 2028-02-27 is a Sunday; 2028 is a leap year.
    expect(between({ kind: 'weekly', days: ['sun'], time: '21:00' }, local(2028, 2, 20, 22), local(2028, 3, 6, 0)))
      .toEqual(['2/27 21:00', '3/5 21:00']);
    expect(between({ kind: 'daily', time: '23:30' }, local(2028, 2, 28, 12), local(2028, 3, 1, 12)))
      .toEqual(['2/28 23:30', '2/29 23:30']);
  });

  test('every N hours is anchored at local midnight without active hours', () => {
    expect(between({ kind: 'interval', everyHours: 6 }, local(2026, 9, 29, 0), local(2026, 9, 30, 0)))
      .toEqual(['9/29 06:00', '9/29 12:00', '9/29 18:00', '9/30 00:00']);
  });

  test('every N hours with active hours starts at the window start and includes its end', () => {
    expect(between({ kind: 'interval', everyHours: 3, window: { start: '09:30', end: '18:30' } },
      local(2026, 9, 29, 0), local(2026, 9, 30, 10)))
      .toEqual(['9/29 09:30', '9/29 12:30', '9/29 15:30', '9/29 18:30', '9/30 09:30']);
  });

  test('once fires exactly once', () => {
    const once = validateSchedule({ kind: 'once', date: '2026-09-30', time: '15:00' }, { now: local(2026, 9, 29) });
    expect(occurrencesBetween(once, local(2026, 9, 29), local(2026, 12, 31)).map(clock)).toEqual(['9/30 15:00']);
    expect(nextRunAfter(once, local(2026, 9, 30, 15))).toBeNull();
  });

  test('the boundary is (from, to]: a time equal to from is not repeated', () => {
    expect(between({ kind: 'daily', time: '09:00' }, local(2026, 9, 29, 9), local(2026, 9, 30, 9))).toEqual(['9/30 09:00']);
  });
});

describe('next run', () => {
  test('is the first time strictly after now', () => {
    const daily = validateSchedule({ kind: 'daily', time: '09:00' });
    expect(clock(nextRunAfter(daily, local(2026, 9, 29, 8, 59)))).toBe('9/29 09:00');
    expect(clock(nextRunAfter(daily, local(2026, 9, 29, 9, 0)))).toBe('9/30 09:00');
    const weekly = validateSchedule({ kind: 'weekly', days: ['mon'], time: '09:00' });
    // Monday 2026-09-28 at 09:01 → next Monday.
    expect(clock(nextRunAfter(weekly, local(2026, 9, 28, 9, 1)))).toBe('10/5 09:00');
  });

  test('labels today, tomorrow and later days', () => {
    const now = local(2026, 9, 29, 10);
    expect(formatNextRun(local(2026, 9, 29, 15), now)).toBe('Today at 3:00 PM');
    expect(formatNextRun(local(2026, 9, 30, 9), now)).toBe('Tomorrow at 9:00 AM');
    expect(formatNextRun(local(2026, 10, 2, 0, 5), now)).toBe('Fri, Oct 2 at 12:05 AM');
    expect(formatNextRun(local(2027, 1, 4, 12), now)).toBe('Mon, Jan 4, 2027 at 12:00 PM');
    expect(formatNextRun(null, now)).toBeNull();
  });
});

describe('one summary sentence per schedule', () => {
  const now = local(2026, 9, 29, 10);
  test.each([
    [{ kind: 'daily', time: '09:00' }, 'Every day at 9:00 AM'],
    [{ kind: 'weekdays', time: '09:00' }, 'Weekdays (Mon–Fri) at 9:00 AM'],
    [{ kind: 'weekly', days: ['mon', 'wed', 'fri'], time: '09:00' }, 'Every Mon, Wed, Fri at 9:00 AM'],
    [{ kind: 'interval', everyHours: 2, window: { start: '09:00', end: '18:00' } }, 'Every 2 hours (09:00–18:00)'],
    [{ kind: 'interval', everyHours: 1 }, 'Every hour'],
    [{ kind: 'once', date: '2026-09-30', time: '15:00' }, 'Once on Sep 30 at 3:00 PM'],
  ])('%o', (schedule, sentence) => {
    expect(describeSchedule(validateSchedule(schedule, { now }), { now })).toBe(sentence);
  });

  test('preview returns the sentence and the next run for a form', () => {
    expect(previewSchedule({ kind: 'daily', time: '09:00' }, { now })).toMatchObject({
      summary: 'Every day at 9:00 AM', nextRunAt: local(2026, 9, 30, 9).toISOString(), nextRunLabel: 'Tomorrow at 9:00 AM' });
  });
});

describe('refusing what the picker cannot express', () => {
  test('cron text is refused', () => {
    const typed = refusal(() => validateSchedule('0 9 * * 1-5'));
    expect(typed).toBeInstanceOf(ScheduleError);
    expect(typed.code).toBe('schedule-unsupported');
    expect(refusal(() => validateSchedule({ cron: '0 9 * * *' })).code).toBe('schedule-unsupported');
  });

  test('an unsupported interval offers the nearest one', () => {
    const error = refusal(() => validateSchedule({ kind: 'interval', everyHours: 5 }));
    expect(error.code).toBe('schedule-unsupported');
    expect(error.field).toBe('schedule.everyHours');
    expect([4, 6]).toContain(error.closest.everyHours);
    expect(refusal(() => validateSchedule({ kind: 'interval', everyHours: 0.5 })).closest).toEqual({ kind: 'interval', everyHours: 1 });
  });

  test('active hours across midnight are refused with the plain interval as closest', () => {
    const error = refusal(() => validateSchedule({ kind: 'interval', everyHours: 2, window: { start: '22:00', end: '06:00' } }));
    expect(error.code).toBe('schedule-unsupported');
    expect(error.closest).toEqual({ kind: 'interval', everyHours: 2 });
  });

  test('unknown kinds, bad times, bad days and impossible dates are refused', () => {
    expect(refusal(() => validateSchedule({ kind: 'monthly', time: '09:00' })).code).toBe('schedule-unsupported');
    expect(refusal(() => validateSchedule({ kind: 'daily', time: '9am' })).field).toBe('schedule.time');
    expect(refusal(() => validateSchedule({ kind: 'daily', time: '24:00' })).field).toBe('schedule.time');
    expect(refusal(() => validateSchedule({ kind: 'weekly', days: [], time: '09:00' })).field).toBe('schedule.days');
    expect(refusal(() => validateSchedule({ kind: 'weekly', days: ['xyz'], time: '09:00' })).field).toBe('schedule.days');
    expect(refusal(() => validateSchedule({ kind: 'once', date: '2026-02-30', time: '09:00' }, { now: local(2026, 1, 1) })).field)
      .toBe('schedule.date');
  });

  test('a once-time already past is refused', () => {
    const error = refusal(() => validateSchedule({ kind: 'once', date: '2026-09-29', time: '09:00' }, { now: local(2026, 9, 29, 10) }));
    expect(error.code).toBe('schedule-in-past');
  });
});

describe('daylight saving time (America/New_York)', () => {
  beforeAll(() => { process.env.TZ = 'America/New_York'; });
  afterAll(() => { process.env.TZ = 'Asia/Seoul'; });

  test('a wall-clock time the spring jump skips runs once, at the moved instant', () => {
    // 2026-03-08 02:00–03:00 does not exist in New York.
    const runs = occurrencesBetween(validateSchedule({ kind: 'daily', time: '02:30' }), local(2026, 3, 7, 12), local(2026, 3, 9, 12));
    expect(runs.map(clock)).toEqual(['3/8 03:30', '3/9 02:30']);
  });

  test('an hourly task keeps one run per real hour across the spring jump', () => {
    const runs = occurrencesBetween(validateSchedule({ kind: 'interval', everyHours: 1 }), local(2026, 3, 8, 0, 30), local(2026, 3, 8, 4, 0));
    const instants = runs.map((date) => date.getTime());
    expect(new Set(instants).size).toBe(instants.length);
    expect(runs.map(clock)).toEqual(['3/8 01:00', '3/8 03:00', '3/8 04:00']);
  });

  test('a repeated wall-clock time in the autumn runs once', () => {
    // 2026-11-01 01:00–02:00 happens twice in New York.
    const runs = occurrencesBetween(validateSchedule({ kind: 'daily', time: '01:30' }), local(2026, 10, 31, 12), local(2026, 11, 1, 12));
    expect(runs).toHaveLength(1);
  });
});
