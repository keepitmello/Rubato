// The processes a call stack started, written down so the next stack can stop them. The engine's
// main thread stops them when the call service ends normally, but an engine that crashes or is
// killed cannot, and macOS does not end a child with its parent: LiveKit then keeps its ports and
// every new stack fails ("listen tcp :7881: bind: address already in use") once a minute.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function commandOf(pid) {
  return new Promise(resolve => execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000 },
    (error, stdout) => resolve(error ? '' : stdout.trim())));
}

/** Records `[{ name, pid, match }]`: `match` is a string the process's command line contains. */
export function recordProcesses(file, processes) {
  writeFileSync(file, `${JSON.stringify(processes.filter(entry => Number.isInteger(entry.pid)))}\n`, { mode: 0o600 });
}

export function forgetProcesses(file) {
  rmSync(file, { force: true });
}

/**
 * Stops what an earlier stack recorded and left running: SIGTERM, then SIGKILL after `waitMs`. A
 * pid that now runs something else (pids are reused) is left alone. Resolves to the stopped names.
 */
export async function stopLeftovers(file, { waitMs = 3_000, command = commandOf } = {}) {
  let recorded;
  try { recorded = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  const stopped = [];
  for (const { name, pid, match } of Array.isArray(recorded) ? recorded : []) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || typeof match !== 'string' || !match) continue;
    if (!alive(pid) || !(await command(pid)).includes(match)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { continue; }
    for (let waited = 0; waited < waitMs && alive(pid); waited += 100) await sleep(100);
    if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ }
    stopped.push(name);
  }
  forgetProcesses(file);
  return stopped;
}
