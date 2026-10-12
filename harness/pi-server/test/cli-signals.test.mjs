import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/sigterm-at-listen.mjs', import.meta.url));

// A restart sends SIGTERM as soon as the socket answers. Before the engine had finished
// starting, the lock library took that signal for an unhandled one: it deleted the profile
// lock while the engine kept serving, and the engine only went down when its next lock
// refresh (5 s later) found the lock gone — or never, when a second copy of that library was
// loaded, and the restart timed out.
test('a SIGTERM that arrives while the engine is still starting shuts it down and frees the profile', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-cli-signal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  const child = spawn(process.execPath, ['--import', preload, cli, '--agent-dir', agentDir], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: root, RUBATO_STOCK_ENGINE_DIR: path.join(root, 'no-engine') },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const started = Date.now();
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const timeout = new Promise((resolve) => setTimeout(() => resolve('still running'), 15000).unref());
  const result = await Promise.race([exited, timeout]);
  if (result === 'still running') child.kill('SIGKILL');
  assert.notEqual(result, 'still running', `engine ignored the SIGTERM it got while starting\n${output}`);
  assert.equal(result.code, 0, output);
  assert.ok(Date.now() - started < 3000, `shutdown took ${Date.now() - started} ms; it waited for the lock refresh\n${output}`);
  assert.doesNotMatch(output, /owner\.lock|compromised/i, 'the lock was taken from a running engine');
  assert.equal(existsSync(path.join(agentDir, 'server', 'owner.lock')), false, 'profile lock was left behind');
  assert.equal(existsSync(path.join(agentDir, 'server', 'pi.sock')), false, 'socket was left behind');
});
