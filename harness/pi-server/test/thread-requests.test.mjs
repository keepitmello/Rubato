import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createThreadRequests } from '../src/thread-requests.mjs';

test('thread requests wait across an engine restart until the app settles them; a newer one of the same kind replaces the older', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-thread-requests-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const file = path.join(root, 'server', 'thread-requests.json');
  const store = createThreadRequests({ file, now: () => 1 });
  await store.add({ sessionId: 'a', action: 'rename', title: 'First' });
  const renamed = await store.add({ sessionId: 'a', action: 'rename', title: ' Second ' });
  const archived = await store.add({ sessionId: 'b', action: 'archive' });
  assert.deepEqual((await store.pending()).map(({ sessionId, action, title }) => ({ sessionId, action, title })),
    [{ sessionId: 'a', action: 'rename', title: 'Second' }, { sessionId: 'b', action: 'archive', title: undefined }]);
  const restarted = createThreadRequests({ file });
  assert.deepEqual(await restarted.pending(), await store.pending());
  assert.equal(await restarted.settle([renamed.id, 'unknown']), 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map((item) => item.id), [archived.id]);
  await assert.rejects(store.add({ sessionId: 'c', action: 'erase' }), TypeError);
  await assert.rejects(store.add({ sessionId: 'c', action: 'rename', title: ' ' }), TypeError);
  await assert.rejects(store.settle('all'), TypeError);
});
