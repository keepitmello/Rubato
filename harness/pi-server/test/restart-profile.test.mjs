import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartProfileEngine } from '../../scripts/restart-profile-engine.mjs';
import { ensureProfileEngine, socketAlive } from '../src/discovery.mjs';
import { SessionClient } from '../src/client.mjs';

const helper = fileURLToPath(new URL('../../scripts/restart-profile-engine.mjs', import.meta.url));
function runHelper(descriptorPath) {
  return spawnSync(process.execPath, [helper, descriptorPath], { encoding: 'utf8' });
}

test('SIGTERM of a spawned profile engine releases the socket; the next client respawns the same identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-restart-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const descriptorPath = path.join(root, 'server', 'connection.json');
  const env = { ...process.env, HOME: root, RUBATO_STOCK_ENGINE_DIR: path.join(root, 'no-engine') };
  const first = await ensureProfileEngine({ descriptorPath, runtimeRoot: null, env, timeoutMs: 20000 });
  t.after(async () => {
    const again = await restartProfileEngine({ descriptorPath, waitMs: 4000 }).catch(() => {});
    if (again?.pid) try { process.kill(again.pid, 'SIGTERM'); } catch {}
  });
  assert.equal(await socketAlive(first.socketPath), true);
  const client = await new SessionClient(first).connect();
  const created = await client.create({ cwd: root, title: 'Keep' });
  await client.close();
  const result = await restartProfileEngine({ descriptorPath, waitMs: 8000 });
  assert.equal(result.restarted, true, JSON.stringify(result));
  assert.equal(await socketAlive(first.socketPath), false);
  const second = await ensureProfileEngine({ descriptorPath, runtimeRoot: null, env, timeoutMs: 20000 });
  assert.equal(second.serverId, first.serverId);
  const resumed = await new SessionClient(second).connect();
  t.after(() => resumed.close());
  assert.equal((await resumed.list()).some((item) => item.sessionId === created.sessionId), true);
  await restartProfileEngine({ descriptorPath, waitMs: 4000 });
});

test('restart is a no-op when no profile engine is listening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-restart-none-'));
  const descriptorPath = path.join(root, 'server', 'connection.json');
  const result = await restartProfileEngine({ descriptorPath });
  assert.equal(result.restarted, false);
  assert.equal(result.reason, 'missing');
  const cli = runHelper(descriptorPath);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), 'missing');
  await rm(root, { force: true, recursive: true });
});

test('a stale descriptor with a dead socket reports dead, not a successful restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-restart-dead-'));
  const serverDir = path.join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  const socketPath = path.join(serverDir, 'pi.sock');
  const descriptorPath = path.join(serverDir, 'connection.json');
  await writeFile(descriptorPath, JSON.stringify({ version: 1, serverId: 'stale', socketPath }) + '\n');
  const result = await restartProfileEngine({ descriptorPath });
  assert.equal(result.restarted, false);
  assert.equal(result.reason, 'dead');
  const cli = runHelper(descriptorPath);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), 'dead');
  await rm(root, { force: true, recursive: true });
});
