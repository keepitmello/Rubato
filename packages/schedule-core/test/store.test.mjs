import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScheduleStore } from '../src/index.mjs';

let root;
let project;
let now;
const store = () => createScheduleStore({ root, now: () => now });
const refusal = async (promise) => { try { await promise; } catch (error) { return error; } throw new Error('expected a refusal'); };
const input = (extra = {}) => ({ name: 'Morning research', cwd: project, prompt: 'Summarize overnight issues',
  schedule: { kind: 'daily', time: '09:00' }, ...extra });
const markSchedulerAlive = () => writeFileSync(path.join(root, 'scheduler.json'),
  JSON.stringify({ pid: process.pid, startedAt: now.toISOString(), lastTickAt: now.toISOString() }));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'schedule-store-'));
  project = mkdtempSync(path.join(tmpdir(), 'schedule-project-'));
  now = new Date('2026-09-29T01:00:00Z');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });

describe('tasks', () => {
  test('a new task is on, has no model by default, and shows its sentence and next run', async () => {
    const task = await store().create(input());
    expect(task).toMatchObject({ name: 'Morning research', cwd: project, model: null, thinking: null, enabled: true,
      summary: expect.stringContaining('Every day at'), running: false, lastRun: null });
    expect(task.nextRunAt).not.toBeNull();
    expect(task).not.toHaveProperty('evaluatedThrough');
    const listed = await store().list();
    expect(listed.revision).toBe(1);
    expect(listed.tasks.map((item) => item.id)).toEqual([task.id]);
    expect(listed.scheduler.running).toBe(false);
  });

  test('invalid fields are refused with the field they belong to', async () => {
    expect((await refusal(store().create(input({ name: ' ' })))).field).toBe('name');
    expect((await refusal(store().create(input({ cwd: path.join(project, 'missing') })))).field).toBe('cwd');
    expect((await refusal(store().create(input({ cwd: 'relative/path' })))).field).toBe('cwd');
    expect((await refusal(store().create(input({ prompt: '' })))).field).toBe('prompt');
    expect((await refusal(store().create(input({ model: 'not a model' })))).field).toBe('model');
    expect((await refusal(store().create(input({ thinking: 'extreme' })))).field).toBe('thinking');
    expect((await refusal(store().create(input({ schedule: '0 9 * * *' })))).code).toBe('schedule-unsupported');
    expect((await store().list()).tasks).toEqual([]);
  });

  test('editing the schedule or switching a task back on restarts judging from now', async () => {
    const task = await store().create(input());
    await store().setEnabled(task.id, false);
    now = new Date('2026-09-30T05:00:00Z');
    await store().setEnabled(task.id, true);
    expect(store().read().tasks[0].evaluatedThrough).toBe(now.toISOString());
    now = new Date('2026-10-01T05:00:00Z');
    await store().update(task.id, { prompt: 'Only the prompt' });
    expect(store().read().tasks[0].evaluatedThrough).toBe('2026-09-30T05:00:00.000Z');
    await store().update(task.id, { schedule: { kind: 'weekdays', time: '10:00' } });
    expect(store().read().tasks[0].evaluatedThrough).toBe(now.toISOString());
  });

  test('saving a form that repeats the same schedule is not a schedule edit: judging is not restarted', async () => {
    const task = await store().create(input());
    const cursor = store().read().tasks[0].evaluatedThrough;
    now = new Date('2026-09-29T00:00:03Z'); // 09:00:03 Seoul, a slot just due
    // The settings form sends every field, the unchanged schedule included (key order and all).
    await store().update(task.id, { ...input(), name: 'Renamed', schedule: { time: '09:00', kind: 'daily' } });
    expect(store().read().tasks[0]).toMatchObject({ name: 'Renamed', evaluatedThrough: cursor });
    await store().update(task.id, { schedule: { kind: 'daily', time: '10:00' } });
    expect(store().read().tasks[0].evaluatedThrough).toBe(now.toISOString());
  });

  test('a finished once-task can be renamed through a form that resends its past schedule', async () => {
    const once = { kind: 'once', date: '2026-09-29', time: '15:00' };
    const task = await store().create(input({ schedule: once }));
    await store().mutate((state) => { state.tasks[0].enabled = false; });
    now = new Date('2026-09-30T00:00:00Z');
    expect((await store().update(task.id, { ...input(), name: 'Renamed', schedule: once, enabled: false })).name).toBe('Renamed');
    expect((await refusal(store().update(task.id, { schedule: once, enabled: true }))).code).toBe('schedule-in-past');
  });

  test('a finished once-task keeps its fields editable but cannot be switched on at a past time', async () => {
    const task = await store().create(input({ schedule: { kind: 'once', date: '2026-09-29', time: '15:00' } }));
    await store().mutate((state) => { state.tasks[0].enabled = false; });
    now = new Date('2026-09-30T00:00:00Z');
    expect((await store().update(task.id, { name: 'Renamed' })).name).toBe('Renamed');
    expect((await refusal(store().setEnabled(task.id, true))).code).toBe('schedule-in-past');
    const moved = await store().update(task.id, { enabled: true, schedule: { kind: 'once', date: '2026-10-02', time: '15:00' } });
    expect(moved.enabled).toBe(true);
  });

  test('deleting a task removes its history and pending requests only', async () => {
    const keep = await store().create(input({ name: 'Keep' }));
    const drop = await store().create(input({ name: 'Drop' }));
    await store().mutate((state) => {
      state.runs.push({ id: 'a', taskId: keep.id, status: 'success', sessionId: 's1' }, { id: 'b', taskId: drop.id, status: 'success', sessionId: 's2' });
    });
    expect(await store().remove(drop.id)).toEqual({ deleted: true });
    const state = store().read();
    expect(state.tasks.map((task) => task.name)).toEqual(['Keep']);
    expect(state.runs.map((run) => run.id)).toEqual(['a']);
    expect((await refusal(store().runs(drop.id))).code).toBe('not-found');
  });
});

describe('run now', () => {
  test('is refused when no scheduler is running', async () => {
    const task = await store().create(input());
    expect((await refusal(store().runNow(task.id))).code).toBe('scheduler-offline');
  });

  test('queues a request for the scheduler, once at a time per task', async () => {
    const task = await store().create(input());
    markSchedulerAlive();
    const { requestId } = await store().runNow(task.id);
    expect(store().read().requests).toEqual([expect.objectContaining({ id: requestId, taskId: task.id, fromRunId: null })]);
    expect((await store().list()).tasks[0].running).toBe(true);
    expect((await refusal(store().runNow(task.id))).code).toBe('already-running');
  });

  test('a rerun names a row of the same task', async () => {
    const task = await store().create(input());
    markSchedulerAlive();
    expect((await refusal(store().runNow(task.id, { fromRunId: 'nope' }))).code).toBe('not-found');
    await store().mutate((state) => { state.runs.push({ id: 'skip1', taskId: task.id, status: 'skipped', reason: 'sleep' }); });
    await store().runNow(task.id, { fromRunId: 'skip1' });
    expect(store().read().requests[0].fromRunId).toBe('skip1');
  });
});

describe('concurrent writers', () => {
  test('no update is lost when many processes-worth of writers race', async () => {
    const writers = Array.from({ length: 25 }, (_, i) => createScheduleStore({ root, now: () => now }).create(input({ name: `Task ${i}` })));
    await Promise.all(writers);
    const state = store().read();
    expect(state.tasks).toHaveLength(25);
    expect(state.revision).toBe(25);
  });

  test('a lock left by a dead process is taken over', async () => {
    writeFileSync(path.join(root, 'state.lock'), `999999 ${Date.now()}\n`);
    await store().create(input());
    expect(store().read().tasks).toHaveLength(1);
  });
});
