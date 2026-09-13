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
