import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordProcesses, stopLeftovers } from '../leftovers.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitExit = child => new Promise(resolve => child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve));

function longRunning(marker) {
  // A process whose command line carries `marker`, standing in for a LiveKit server a crashed engine left.
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' });
}

test('a process an earlier stack recorded and left running is stopped', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'call-leftovers-')), 'processes.json');
  const child = longRunning('leftover-livekit-marker');
  recordProcesses(file, [{ name: 'livekit', pid: child.pid, match: 'leftover-livekit-marker' }]);
  assert.deepEqual(await stopLeftovers(file), ['livekit']);
  await waitExit(child);
  assert.equal(alive(child.pid), false);
  assert.equal(existsSync(file), false);
});

test('a recorded pid that now runs another program is left alone', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'call-leftovers-')), 'processes.json');
  const child = longRunning('someone-else');
  try {
    recordProcesses(file, [{ name: 'livekit', pid: child.pid, match: '/opt/homebrew/bin/livekit-server' }]);
    assert.deepEqual(await stopLeftovers(file), []);
    assert.equal(alive(child.pid), true);
  } finally { child.kill('SIGKILL'); await waitExit(child); }
});

test('no record, a broken record or an ended process is not an error', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'call-leftovers-'));
  assert.deepEqual(await stopLeftovers(path.join(dir, 'none.json')), []);
  const broken = path.join(dir, 'broken.json');
  writeFileSync(broken, '{not json');
  assert.deepEqual(await stopLeftovers(broken), []);
  const ended = longRunning('ended-marker');
  ended.kill('SIGKILL'); await waitExit(ended);
  const file = path.join(dir, 'ended.json');
  recordProcesses(file, [{ name: 'agent', pid: ended.pid, match: 'ended-marker' }]);
  assert.deepEqual(await stopLeftovers(file), []);
});
