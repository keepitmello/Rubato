import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionFiles } from '../src/session-files.mjs';

test('an empty real Pi session survives a fresh directory view without a worker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const created = await store.create({ cwd: tmpdir(), title: 'Persist before prompt' });
  const restored = await new SessionFiles(root).resolve(created.id);
  assert.equal(restored.id, created.id);
  assert.equal(restored.title, 'Persist before prompt');
  assert.equal(restored.messageCount, 0);
  assert.equal(JSON.parse((await readFile(restored.file, 'utf8')).split('\n')[0]).type, 'session');
  await assert.rejects(store.resolve('missing-session'), /not found/i);
  assert.equal((await store.list()).length, 1);
});

test('a title created as locked is one the automatic session title never replaces', async (t) => {
  const { isTitleLocked } = await import('../../pi-runtime/features/session-title/session-title.mjs');
  const root = await mkdtemp(join(tmpdir(), 'rubato-session-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionFiles(root);
  const entries = async (created) => (await readFile(created.file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const locked = await store.create({ cwd: tmpdir(), title: '⏰ Morning research · 9/24 09:00', titleLocked: true });
  assert.equal(locked.title, '⏰ Morning research · 9/24 09:00');
  assert.equal(isTitleLocked(await entries(locked)), true);
  const ordinary = await store.create({ cwd: tmpdir(), title: 'New thread' });
  assert.equal(isTitleLocked(await entries(ordinary)), false);
});
