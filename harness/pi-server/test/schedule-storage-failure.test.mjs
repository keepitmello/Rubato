import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createScheduleStore } from '../../../packages/schedule-core/src/store.mjs';

for (const failureAt of ['lock', 'state', 'rename']) {
  test(`ENOSPC during ${failureAt} leaves no lock, fd or temporary file and the next write works`, async (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'schedule-full-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createScheduleStore({ root });
    await store.mutate(state => { state.requests.push({ id: 'before' }); });
    const write = fs.writeFileSync;
    const close = fs.closeSync;
    let lockFd, lockClosed = false;
    const failure = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (typeof file === 'number') {
        lockFd = file;
        if (failureAt === 'lock') throw failure;
      } else if (failureAt === 'state' && String(file).endsWith('.tmp')) {
        write(file, '', ...args.slice(1)); // Simulate a partial file left by a failed write.
        throw failure;
      }
      return write(file, ...args);
    });
    t.mock.method(fs, 'closeSync', (fd) => {
      if (fd === lockFd) lockClosed = true;
      return close(fd);
    });
    if (failureAt === 'rename') t.mock.method(fs, 'renameSync', () => { throw failure; });
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.mutate(state => { state.requests.push({ id: 'lost' }); }), e => e === failure);
      assert.equal(lockClosed, true);
      assert.equal(fs.existsSync(store.files.lock), false);
      assert.deepEqual(fs.readdirSync(root), ['state.json']);
      assert.deepEqual(store.read().requests, [{ id: 'before' }]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    await store.mutate(state => { state.requests.push({ id: 'kept' }); });
    assert.deepEqual(store.read().requests, [{ id: 'before' }, { id: 'kept' }]);
  });
}

test('a freshly opened empty lock is not stolen while its writer is filling it', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'schedule-opening-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createScheduleStore({ root });
  const fd = fs.openSync(store.files.lock, 'wx');
  let changed = false;
  const pending = store.mutate(() => { changed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(changed, false);
    assert.equal(fs.readFileSync(store.files.lock, 'utf8'), '');
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(store.files.lock);
    await pending;
  }
  assert.equal(changed, true);
});
