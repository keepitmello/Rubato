import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GRACE_MS, judgeTask, pruneRuns, recordSkip, validateSchedule } from '../src/index.mjs';

const previousTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Asia/Seoul'; });
afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const task = (schedule, evaluatedThrough, extra = {}) => ({ id: 't1', cwd: '/tmp', schedule: validateSchedule(schedule, { now: new Date(0) }),
  enabled: true, evaluatedThrough: evaluatedThrough.toISOString(), ...extra });
let seq = 0;
const newId = () => `r${++seq}`;

describe('judging a due time', () => {
  test('a time reached on the regular tick runs', () => {
    const result = judgeTask(task({ kind: 'daily', time: '09:00' }, local(2026, 9, 29, 8, 59, 50)),
      { now: local(2026, 9, 29, 9, 0, 5), schedulerStartedAt: local(2026, 9, 28) });
    expect(result.fire).toEqual(local(2026, 9, 29, 9));
    expect(result.skips).toEqual([]);
    expect(result.evaluatedThrough).toEqual(local(2026, 9, 29, 9, 0, 5));
  });

  test('the grace window is inclusive at five minutes and skips just past it', () => {
    const within = judgeTask(task({ kind: 'daily', time: '09:00' }, local(2026, 9, 29, 8, 50)),
      { now: new Date(local(2026, 9, 29, 9).getTime() + GRACE_MS), schedulerStartedAt: local(2026, 9, 28) });
    expect(within.fire).toEqual(local(2026, 9, 29, 9));
    const past = judgeTask(task({ kind: 'daily', time: '09:00' }, local(2026, 9, 29, 8, 50)),
      { now: new Date(local(2026, 9, 29, 9).getTime() + GRACE_MS + 1000), schedulerStartedAt: local(2026, 9, 28) });
    expect(past.fire).toBeNull();
    expect(past.skips).toEqual([{ scheduledFor: local(2026, 9, 29, 9), reason: 'sleep' }]);
  });

  test('missed times are never caught up; the reason says only what was observed', () => {
    const overnight = task({ kind: 'interval', everyHours: 2 }, local(2026, 9, 29, 0, 30));
    // The scheduler was alive the whole night and its clock jumped: the process was suspended.
    const asleep = judgeTask(overnight, { now: local(2026, 9, 29, 7, 40), schedulerStartedAt: local(2026, 9, 28) });
    expect(asleep.fire).toBeNull();
    expect(asleep.skips.map((skip) => [skip.scheduledFor.getHours(), skip.reason]))
      .toEqual([[2, 'sleep'], [4, 'sleep'], [6, 'sleep']]);
    // The scheduler started only now: it cannot tell sleep from power-off or not installed.
    const cold = judgeTask(overnight, { now: local(2026, 9, 29, 7, 40), schedulerStartedAt: local(2026, 9, 29, 7, 39) });
    expect(cold.skips.every((skip) => skip.reason === 'not-running')).toBe(true);
    expect(judgeTask(overnight, { now: local(2026, 9, 29, 7, 40) }).skips.every((skip) => skip.reason === 'not-running')).toBe(true);
  });

  test('after a gap, only the latest time within grace runs and older ones are skipped', () => {
    const result = judgeTask(task({ kind: 'interval', everyHours: 1 }, local(2026, 9, 29, 5, 30)),
      { now: local(2026, 9, 29, 8, 2), schedulerStartedAt: local(2026, 9, 28) });
    expect(result.fire).toEqual(local(2026, 9, 29, 8));
    expect(result.skips.map((skip) => skip.scheduledFor.getHours())).toEqual([6, 7]);
  });

  test('a due time while the previous run is still going is an overlap skip', () => {
    const result = judgeTask(task({ kind: 'interval', everyHours: 1 }, local(2026, 9, 29, 8, 59)),
      { now: local(2026, 9, 29, 9, 0, 10), schedulerStartedAt: local(2026, 9, 28), running: true });
    expect(result.fire).toBeNull();
    expect(result.skips).toEqual([{ scheduledFor: local(2026, 9, 29, 9), reason: 'overlap' }]);
  });

  test('a once-task is switched off after its time is judged, whether it ran or was skipped', () => {
    const once = { kind: 'once', date: '2026-09-29', time: '09:00' };
    const ran = judgeTask(task(once, local(2026, 9, 29, 8, 59)), { now: local(2026, 9, 29, 9, 0, 3), schedulerStartedAt: local(2026, 9, 28) });
    expect(ran).toMatchObject({ disable: true });
    expect(ran.fire).not.toBeNull();
    const missed = judgeTask(task(once, local(2026, 9, 29, 8)), { now: local(2026, 9, 29, 11), schedulerStartedAt: local(2026, 9, 28) });
    expect(missed.disable).toBe(true);
    expect(missed.skips).toHaveLength(1);
    const before = judgeTask(task(once, local(2026, 9, 29, 8)), { now: local(2026, 9, 29, 8, 30) });
    expect(before.disable).toBe(false);
  });

  test('a task without a cursor is only stamped; nothing in the past is judged', () => {
    const fresh = { ...task({ kind: 'daily', time: '09:00' }, local(2026, 9, 29)), evaluatedThrough: null };
    expect(judgeTask(fresh, { now: local(2026, 9, 29, 12) })).toMatchObject({ fire: null, skips: [], disable: false });
  });
});

describe('skip rows', () => {
  const base = { taskId: 't1', cwd: '/tmp', newId, now: local(2026, 9, 29, 7, 40) };

  test('consecutive skips with the same reason collapse into one row', () => {
    const runs = [];
    for (const hour of [1, 3, 5, 7]) recordSkip(runs, { ...base, scheduledFor: local(2026, 9, 29, hour), reason: 'sleep' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'skipped', reason: 'sleep', skipCount: 4,
      scheduledFor: local(2026, 9, 29, 1).toISOString(), lastScheduledFor: local(2026, 9, 29, 7).toISOString() });
  });

  test('a different reason, another run in between, or another task starts a new row', () => {
    const runs = [];
    recordSkip(runs, { ...base, scheduledFor: local(2026, 9, 29, 1), reason: 'sleep' });
    recordSkip(runs, { ...base, taskId: 't2', scheduledFor: local(2026, 9, 29, 1), reason: 'sleep' });
    recordSkip(runs, { ...base, scheduledFor: local(2026, 9, 29, 2), reason: 'sleep' });
    expect(runs.filter((run) => run.taskId === 't1')).toHaveLength(1);
    recordSkip(runs, { ...base, scheduledFor: local(2026, 9, 29, 3), reason: 'overlap' });
    runs.push({ id: 'x', taskId: 't1', status: 'success' });
    recordSkip(runs, { ...base, scheduledFor: local(2026, 9, 29, 5), reason: 'overlap' });
    expect(runs.filter((run) => run.taskId === 't1').map((run) => run.reason ?? run.status))
      .toEqual(['sleep', 'overlap', 'success', 'overlap']);
  });

  test('retention keeps the newest rows per task and never drops a running row', () => {
    const runs = [{ id: 'old-running', taskId: 'a', status: 'running' }];
    for (let i = 0; i < 5; i++) runs.push({ id: `a${i}`, taskId: 'a', status: 'success' });
    runs.push({ id: 'b0', taskId: 'b', status: 'success' });
    expect(pruneRuns(runs, 3).map((run) => run.id)).toEqual(['old-running', 'a2', 'a3', 'a4', 'b0']);
  });
});
