#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDescriptor } from '../pi-server/src/descriptor.mjs';
import { socketAlive } from '../pi-server/src/discovery.mjs';
import { SessionClient } from '../pi-server/src/client.mjs';
import { resolveLaunchAgentDir } from '../rubato-pi/src/launch.mjs';

function pathVariants(dir) {
  const variants = new Set([dir, path.resolve(dir)]);
  try { variants.add(realpathSync(dir)); } catch {}
  for (const value of [...variants]) {
    if (value.startsWith('/private/')) variants.add(value.slice('/private'.length));
    else if (value.startsWith('/')) variants.add(`/private${value}`);
  }
  return variants;
}

/** Every pid the machine will name, paired with the command line `ps` prints for it.
 *
 * `pgrep -l` means "list the full command line" on BSD and "list the process name" on
 * procps, so `-lf` output cannot be parsed the same way on macOS and Linux: on Linux
 * every row reads `1234 node` and no row ever contains cli.mjs. Take pids from pgrep and
 * read each command line with ps, which prints the same thing on both.
 *
 * pgrep is not reliable on its own, either. On macOS it reports nothing at all for some
 * processes whose command line `ps` shows in full — measured on this machine: the running
 * profile engine was absent from `pgrep -f node` while `ps -p <pid> -o command=` printed
 * it. A miss here does not fail loudly; it reports no-pid, leaves the old engine running,
 * and the machine keeps serving code from before the update. So scan ps as well and merge
 * by pid, rather than trusting either source alone.
 */
export function processTable(run = spawnSync) {
  const rows = new Map();
  const listed = run('pgrep', ['-f', 'cli.mjs --agent-dir'], { encoding: 'utf8' });
  if (listed.status === 0) {
    for (const line of listed.stdout.split('\n')) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 1) continue;
      const inspected = run('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      if (inspected.status === 0) rows.set(pid, inspected.stdout.trim());
    }
  }
  const scanned = run('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' });
  if (scanned.status === 0) {
    for (const line of scanned.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
      if (match === null) continue;
      const pid = Number(match[1]);
      if (pid <= 1 || rows.has(pid)) continue;
      rows.set(pid, match[2]);
    }
  }
  return rows;
}

// Exported so a test can point it at a process it spawned itself.
export function listenerPid(agentDir, run = spawnSync) {
  const dirs = pathVariants(agentDir);
  for (const [pid, command] of processTable(run)) {
    if (pid === process.pid) continue;
    if (!command.includes('cli.mjs')) continue;
    for (const dir of dirs) {
      // The flag has to END at the dir: `--agent-dir /x/agent` is a prefix of
      // `--agent-dir /x/agent2`, and matching that would SIGTERM an unrelated profile.
      const flag = `--agent-dir ${dir}`;
      const at = command.indexOf(flag);
      if (at === -1) continue;
      const rest = command.slice(at + flag.length);
      if (rest === '' || /^\s/.test(rest)) return pid;
    }
  }
}

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
