import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { announceUnloadOnDispose, loadHostedRuntime } from '../src/hosted-runtime.mjs';
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

test('hosted worker dispose announces unload, not quit, so resident children suspend instead of dying', async () => {
  const emitted = []; let invalidated = 0, disposed = 0;
  const runtime = {
    session: { extensionRunner: { id: 'runner' }, dispose: () => { disposed++; } },
    beforeSessionInvalidate: () => { invalidated++; },
    dispose: async () => { emitted.push({ type: 'session_shutdown', reason: 'quit' }); },
  };
  const emit = async (runner, event) => { assert.equal(runner, runtime.session.extensionRunner); emitted.push(event); };
  assert.equal(announceUnloadOnDispose(runtime, emit), runtime);
  const once = runtime.dispose;
  assert.equal(announceUnloadOnDispose(runtime, emit).dispose, once, 'a second announce keeps the same dispose');
  await runtime.dispose();
  assert.deepEqual(emitted, [{ type: 'session_shutdown', reason: 'unload' }]);
  assert.equal(invalidated, 1); assert.equal(disposed, 1);
  // The CLI cursor owns its own lifecycle and must keep it.
  const cursor = { lifecycle: {}, dispose: async () => 'cursor' };
  assert.equal(announceUnloadOnDispose(cursor, emit).dispose, cursor.dispose);
});

test('failed engine selection releases the profile owner rather than blocking recovery', async t => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-engine-failed-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await assert.rejects(serveProfile({ agentDir, runtimeRoot: path.join(agentDir, 'missing-build') }), { code: 'ENOENT' });
  const cliPath = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
  const recovered = await serveProfile({ agentDir, workerFactory: metadata => new RpcWorker(metadata, { cliPath }) });
  await recovered.close();
});
