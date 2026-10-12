import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { restartProfileEngine } from '../../scripts/restart-profile-engine.mjs';
import { ensureProfileEngine, socketAlive } from '../src/discovery.mjs';

// During a restart the old engine still holds the profile lock while it puts its sessions
// away, after its socket has already gone. The engine a client starts then exits at once
// ("Lock file is already being held"). The client must start another as soon as the lock is
// free, not after waiting out a fixed five-second window.
test('an engine that exits at once on a held profile lock is started again without a fixed wait', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-respawn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverDir = path.join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  const descriptorPath = path.join(serverDir, 'connection.json');
  const env = { ...process.env, HOME: root, RUBATO_STOCK_ENGINE_DIR: path.join(root, 'no-engine') };
  // The same lock the engine takes (profile-server.mjs), held the way the old engine holds it.
  const release = await lockfile.lock(root, { lockfilePath: path.join(serverDir, 'owner.lock'), stale: 15000, update: 5000, retries: 0 });
  setTimeout(() => { void release(); }, 400);
  const started = Date.now();
  const descriptor = await ensureProfileEngine({ descriptorPath, runtimeRoot: null, env, timeoutMs: 20000 });
  const elapsed = Date.now() - started;
  t.after(() => restartProfileEngine({ descriptorPath, waitMs: 4000 }).catch(() => {}));
  assert.equal(await socketAlive(descriptor.socketPath), true);
  assert.ok(elapsed < 3500, `engine came up ${elapsed} ms after the lock was free at 400 ms`);
});
