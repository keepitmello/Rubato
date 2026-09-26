// Finding the running profile engine's pid, kept free of every import but node's own.
//
// It lives apart from `restart-profile-engine.mjs` so it can be tested without pulling in
// the pi-server client: the pi-runtime job that runs these tests does not install
// `harness/pi-server/node_modules`, so importing that script from a test fails the whole
// file with ERR_MODULE_NOT_FOUND before a single assertion runs.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export function pathVariants(dir) {
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

/** Every pid above `start` in the parent chain, `start` itself excluded.
 *
 * A conversation hosted by the profile engine runs its tools as children of that engine, so a
 * command such as `rubato dispatch` or `npm run build` started from a conversation has the
 * engine among its ancestors. Restarting the engine from there cuts the conversation that asked.
 */
export function ancestorPids(start = process.pid, run = spawnSync) {
  const parents = new Map();
  const table = run('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  if (table.status === 0) {
    for (const line of table.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) parents.set(Number(match[1]), Number(match[2]));
    }
  }
  const ancestors = new Set();
  for (let pid = parents.get(start); pid && pid > 1 && !ancestors.has(pid); pid = parents.get(pid)) ancestors.add(pid);
  return ancestors;
}
