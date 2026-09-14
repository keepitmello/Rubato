import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadHostedRuntime } from '../src/hosted-runtime.mjs';
import { serveProfile } from '../src/profile-server.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';

test('incomplete engine CLI never implicitly opens the normal profile', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-engine-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--runtime-root', '/candidate'],
    { env: { HOME: home, PATH: process.env.PATH } }), error => {
    assert.match(error.stderr, /requires an explicit --agent-dir/);
    return error.code === 1;
  });
  await assert.rejects(access(path.join(home, '.rubato')), { code: 'ENOENT' });
});

test('hosted runtime requires absolute identity before loading any agent code', async () => {
  await assert.rejects(loadHostedRuntime({ runtimeRoot: 'relative', agentDir: '/profile' }), /absolute/);
  await assert.rejects(loadHostedRuntime({ runtimeRoot: '/build', agentDir: 'relative' }), /absolute/);
});

test('failed engine selection releases the profile owner rather than blocking recovery', async t => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-engine-failed-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await assert.rejects(serveProfile({ agentDir, runtimeRoot: path.join(agentDir, 'missing-build') }), { code: 'ENOENT' });
  const cliPath = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
  const recovered = await serveProfile({ agentDir, workerFactory: metadata => new RpcWorker(metadata, { cliPath }) });
  await recovered.close();
});
