// One engine keeps a companion home. Two engines driving the same home fight over its state: on
// 2026-11-09 an isolated test engine that inherited the companions file ran a keeper on the live
// Roo home, and the two keepers flipped Roo's conversation six times in thirty seconds. Each
// companion service (keeper, dream, messenger) therefore claims its kind in the home before it
// starts; a claim another live engine holds makes the start fail, and the supervisor tries again
// with its backoff. The claim is a lock directory refreshed while the service runs, the same
// mechanism as the engine's own profile lock: a crashed engine's claim goes stale and the next
// engine takes it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

export const CLAIM_TIMINGS = Object.freeze({ stale: 15_000, update: 5_000 });

/** Where a kind's claim and its holder note live inside the home. */
export function claimPaths(home, kind) {
  const dir = path.join(home, '.engine-claims');
  return { dir, lock: path.join(dir, `${kind}.lock`), owner: path.join(dir, `${kind}.owner.json`) };
}

/**
 * Claims `kind` in the companion `home` for this engine (`agentDir`), or throws `COMPANION_HOME_HELD`
 * naming the engine that keeps it. Resolves to the release function.
 */
export async function claimCompanionHome({ home, kind, agentDir, onCompromised, timings = CLAIM_TIMINGS }) {
  const paths = claimPaths(home, kind);
  mkdirSync(paths.dir, { recursive: true });
  let release;
  try {
    release = await lockfile.lock(home, { lockfilePath: paths.lock, realpath: false, retries: 0,
      stale: timings.stale, update: timings.update, ...(onCompromised ? { onCompromised } : {}) });
  } catch (error) {
    if (error?.code !== 'ELOCKED') throw error;
    let holder = 'another engine';
    try {
      const owner = JSON.parse(readFileSync(paths.owner, 'utf8'));
      if (owner?.agentDir) holder = `the engine at ${owner.agentDir} (pid ${owner.pid})`;
    } catch { /* no note: the holder started before notes were written */ }
    throw Object.assign(new Error(`The companion home ${home} is kept by ${holder}; this engine leaves its ${kind} alone`),
      { code: 'COMPANION_HOME_HELD' });
  }
  writeFileSync(paths.owner, JSON.stringify({ pid: process.pid, agentDir, at: new Date().toISOString() }) + '\n');
  return release;
}
