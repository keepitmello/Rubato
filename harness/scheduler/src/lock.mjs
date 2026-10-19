// One scheduler per schedule directory: whoever holds `daemon.lock` judges the tasks. The engine's
// scheduler service (service.mjs) and a standalone daemon (daemon.mjs) take the same lock, so a
// machine still running the old launchd scheduler never judges a task twice while it moves over.
// The file holds the holder's pid; a holder that is gone, or this very process (a service thread
// started again inside the same engine), does not count.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export const schedulerLockFile = (root) => path.join(root, 'daemon.lock');

/** Takes the lock; false while another live process holds it. */
export function tryLock(root) {
  const lockFile = schedulerLockFile(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = NaN;
    try { holder = Number(readFileSync(lockFile, 'utf8').trim()); } catch {}
    if (pidAlive(holder)) return false;
    try { unlinkSync(lockFile); } catch {}
  }
  return false;
}

/** Removes the lock if this process holds it. */
export function releaseLock(root) {
  const lockFile = schedulerLockFile(root);
  try { if (Number(readFileSync(lockFile, 'utf8').trim()) === process.pid) unlinkSync(lockFile); } catch {}
}
