import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createScheduleService, handleScheduleRequest } from '../src/schedule/service.mjs';
import { createScheduleStore, describeSchedule } from '../../../packages/schedule-core/src/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-schedule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HOME: root, RUBATO_SCHEDULE_HOME: path.join(root, 'schedule') };
  const service = createScheduleService({ env });
  const call = async (action, body = {}, method = 'POST') => {
    const response = await handleScheduleRequest(service, new Request(`http://mac/rubato/schedule/${action}`, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { root, env, call };
}

const daily = { kind: 'daily', time: '09:00' };

test('the page and the other clients share one store', async (t) => {
  const { root, env, call } = await fixture(t);
  const created = await call('create', { task: { name: 'Digest', cwd: root, prompt: 'Summarize', schedule: daily } });
  assert.equal(created.status, 200);
  assert.equal(created.body.summary, describeSchedule(daily));
  assert.equal(created.body.enabled, true);
  assert.equal(typeof created.body.nextRunLabel, 'string');

  // What the page wrote, the session tool and the CLI read (same store module).
  const other = createScheduleStore({ env });
  assert.deepEqual((await other.list()).tasks.map((task) => task.name), ['Digest']);
  // And what they write, the page lists.
  await other.create({ name: 'From a session', cwd: root, prompt: 'Check deps', schedule: { kind: 'weekdays', time: '08:30' } });
  const list = await call('list');
  assert.deepEqual(list.body.tasks.map((task) => task.name).toSorted(), ['Digest', 'From a session']);
  assert.equal(list.body.home, root);
  assert.equal(list.body.scheduler.running, false);

  const revision = (await call('revision')).body.revision;
  const off = await call('set-enabled', { taskId: created.body.id, enabled: false });
  assert.equal(off.body.enabled, false);
  assert.ok((await call('revision')).body.revision > revision);

  const weekly = { kind: 'weekly', days: ['mon', 'fri'], time: '07:00' };
  const updated = await call('update', { taskId: created.body.id, patch: { schedule: weekly } });
  assert.equal(updated.body.summary, describeSchedule(weekly));

  assert.deepEqual((await call('runs', { taskId: created.body.id })).body.runs, []);
  assert.deepEqual((await call('delete', { taskId: created.body.id })).body, { deleted: true });
  assert.deepEqual((await call('list')).body.tasks.map((task) => task.name), ['From a session']);
});

test('errors name the input they belong to', async (t) => {
  const { root, call } = await fixture(t);
  const noFolder = await call('create', { task: { name: 'X', cwd: path.join(root, 'missing'), prompt: 'p', schedule: daily } });
  assert.equal(noFolder.status, 400);
  assert.equal(noFolder.body.error.field, 'cwd');
  assert.equal(typeof noFolder.body.error.message, 'string');

  const badTime = await call('preview', { schedule: { kind: 'daily', time: '25:00' } });
  assert.equal(badTime.status, 400);
  assert.match(badTime.body.error.field, /^schedule/);

  const past = await call('create', { task: { name: 'X', cwd: root, prompt: 'p', schedule: { kind: 'once', date: '2020-01-01', time: '09:00' } } });
  assert.equal(past.body.error.code, 'schedule-in-past');

  assert.equal((await call('update', { taskId: 'nope', patch: { name: 'y' } })).status, 404);
  assert.equal((await call('frobnicate')).status, 404);
  assert.equal((await call('list', {}, 'GET')).status, 405);
});

test('preview speaks the shared sentence; run now needs the scheduler', async (t) => {
  const { root, call } = await fixture(t);
  const interval = { kind: 'interval', everyHours: 2, window: { start: '09:00', end: '18:00' } };
  const preview = await call('preview', { schedule: interval });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.summary, describeSchedule(interval));
  assert.equal(typeof preview.body.nextRunLabel, 'string');

  const task = (await call('create', { task: { name: 'Digest', cwd: root, prompt: 'p', schedule: daily } })).body;
  const refused = await call('run-now', { taskId: task.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'scheduler-offline');
});
