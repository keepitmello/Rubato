#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDescriptor } from '../pi-server/src/descriptor.mjs';
import { socketAlive } from '../pi-server/src/discovery.mjs';
import { SessionClient } from '../pi-server/src/client.mjs';
import { resolveLaunchAgentDir } from '../rubato-pi/src/launch.mjs';
// Process lookup lives apart so a test can reach it without the pi-server client above.
import { listenerPid } from './profile-engine-pid.mjs';

async function runningTurns(descriptor) {
  const client = await new SessionClient({ ...descriptor, timeoutMs: 2500 }).connect();
  try {
    return (await client.list()).filter((item) => ['running', 'waiting', 'starting'].includes(item.status));
  } finally { await client.close(); }
}

export async function restartProfileEngine({ descriptorPath, waitMs = 8000 } = {}) {
  descriptorPath ??= path.join(resolveLaunchAgentDir(), 'server', 'connection.json');
  if (!path.isAbsolute(descriptorPath)) throw new TypeError('descriptorPath must be absolute');
  let descriptor;
  try { descriptor = await readDescriptor(descriptorPath); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { restarted: false, reason: 'missing' };
    throw error;
  }
  if (!await socketAlive(descriptor.socketPath)) return { restarted: false, reason: 'dead' };
  let running = [];
  let inspectError = false;
  try { running = await runningTurns(descriptor); }
  catch { inspectError = true; }
  const pid = listenerPid(path.dirname(path.dirname(descriptor.socketPath)));
  if (!pid) return { restarted: false, reason: 'no-pid', running, inspectError };
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!await socketAlive(descriptor.socketPath)) return { restarted: true, pid, running, inspectError };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { restarted: false, reason: 'timeout', pid, running, inspectError };
}

function isCli() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isCli()) {
  const result = await restartProfileEngine({ descriptorPath: process.argv[2] });
  if (result.inspectError) {
    process.stderr.write('진행 중인 대화를 확인하지 못했습니다. 프로필 엔진을 재시작합니다.\n');
  } else if (result.running?.length) {
    const names = result.running.map((item) => item.title || item.sessionId || 'untitled').join(', ');
    process.stderr.write(`진행 중인 대화 ${result.running.length}개를 끊습니다: ${names}\n`);
  }
  const token = result.restarted ? 'restarted' : result.reason === 'timeout' && result.pid
    ? `timeout ${result.pid}` : (result.reason ?? 'unknown');
  process.stdout.write(`${token}\n`);
  process.exit(result.restarted || result.reason === 'missing' || result.reason === 'dead' ? 0 : 1);
}
