import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeAndExit, describeResources, STOP_LIMIT_MS } from '../src/engine-stop.mjs';
import { DRAIN_TIMEOUT_MS } from '../src/drain.mjs';
import { CLOSE_WAIT_MS } from '../../scripts/restart-profile-engine.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const leftover = fileURLToPath(new URL('./fixtures/leftover-handle.mjs', import.meta.url));

// The unref'd timers in closeAndExit do not keep a test alive on their own.
const exited = () => {
  let resolve;
  const keepAlive = setTimeout(() => {}, 10_000);
  const done = new Promise((r) => { resolve = r; });
  return { exit: (code) => { clearTimeout(keepAlive); resolve(code); }, done };
};

test('a close that never finishes still ends the engine, naming the step it is stuck in', async () => {
  const { exit, done } = exited();
  const lines = [];
  void closeAndExit({ closingStep: 'conversations', close: () => new Promise(() => {}) },
    { exit, log: (line) => lines.push(line), limitMs: 50, resources: () => ['PipeWrap', 'Timeout', 'Timeout'] });
  assert.equal(await done, 1);
  assert.match(lines.join('\n'), /did not finish within .*stuck at: conversations; still open: PipeWrap, Timeout ×2/);
});

test('a closed engine that something still holds exits after the grace and names what held it', async () => {
  const { exit, done } = exited();
  const lines = [];
  const code = await closeAndExit({ close: async () => {} },
    { exit, log: (line) => lines.push(line), graceMs: 20, resources: () => ['Timeout'] });
  assert.equal(code, 0);
  assert.equal(await done, 0);
  assert.match(lines.join('\n'), /closed, but Timeout still held the process/);
});

test('a failed close still ends the engine, with a failing code', async () => {
  const { exit, done } = exited();
  const code = await closeAndExit({ close: async () => { throw new Error('boom'); } },
    { exit, log: () => {}, graceMs: 20, resources: () => [] });
  assert.equal(code, 1);
  assert.equal(await done, 1);
  assert.equal(describeResources([]), 'nothing');
});

// A restart waits for the old process this long once its socket is gone; the engine must leave first.
test('the stop limit covers the drain and ends inside what a restart waits for', () => {
  assert.ok(STOP_LIMIT_MS > DRAIN_TIMEOUT_MS);
  assert.ok(STOP_LIMIT_MS < CLOSE_WAIT_MS);
});

// 2026-10-23: an engine stopped by an update closed its socket and never ended. launchd counted
// it as running and started no other, and the app found no engine for 17 minutes.
test('an engine whose event loop is held after closing still ends on SIGTERM and frees the profile', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  const child = spawn(process.execPath, ['--import', leftover, cli, '--agent-dir', agentDir], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: root, RUBATO_STOCK_ENGINE_DIR: path.join(root, 'no-engine') },
  });
  let output = '';
  const ready = new Promise((resolve) => child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('"socketPath"')) resolve('ready');
  }));
  child.stderr.on('data', (chunk) => { output += chunk; });
  const result = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const started = await Promise.race([ready, result, new Promise((resolve) => setTimeout(resolve, 15_000, 'no start').unref())]);
  if (started !== 'ready') child.kill('SIGKILL');
  assert.equal(started, 'ready', `engine did not start\n${output}`);
  child.kill('SIGTERM');
  const ended = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('still running'), 15_000).unref())]);
  if (ended === 'still running') child.kill('SIGKILL');
  assert.notEqual(ended, 'still running', `engine stayed alive after closing\n${output}`);
  assert.equal(ended.code, 0, output);
  assert.match(output, /closed, but .*Timeout.* still held the process; exiting/);
  assert.equal(existsSync(path.join(agentDir, 'server', 'owner.lock')), false, 'profile lock was left behind');
  assert.equal(existsSync(path.join(agentDir, 'server', 'pi.sock')), false, 'socket was left behind');
});

test('an engine that fails to start ends even when something holds its event loop', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--import', leftover, cli, '--agent-dir', path.join(root, 'agent'),
    '--socket', path.join(root, 'x'.repeat(120))], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: root, RUBATO_STOCK_ENGINE_DIR: path.join(root, 'no-engine') },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const result = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ended = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('still running'), 15_000).unref())]);
  if (ended === 'still running') child.kill('SIGKILL');
  assert.notEqual(ended, 'still running', `engine stayed alive after a failed start\n${output}`);
  assert.equal(ended.code, 1, output);
  assert.match(output, /Socket path is too long/);
});
