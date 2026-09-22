import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const exists = (path) => lstat(path).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

const OWNER_FILE = "owner.json";
// A holder writes its owner file immediately after `mkdir`. A lock with no owner
// file is either that instant or a holder killed between the two calls, so it only
// counts as stale once it is clearly older than that gap.
const OWNER_GRACE_MS = 10_000;

const ownerPath = (lock) => join(lock, OWNER_FILE);

async function readOwner(lock) {
  try {
    const parsed = JSON.parse(await readFile(ownerPath(lock), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another user: still a live holder.
    return error.code === "EPERM";
  }
}

// A killed install leaves its lock behind and every later install then fails on it
// forever, because the lock holds no evidence of who owns it. Recording the owner
// makes a dead holder distinguishable from a live one, so the lock heals itself
// instead of waiting for someone to delete the directory by hand.
async function lockIsStale(lock) {
  const owner = await readOwner(lock);
  if (owner !== undefined) return !holderAlive(owner.pid);
  const stats = await lstat(lock).catch(() => undefined);
  return stats !== undefined && Date.now() - stats.mtimeMs > OWNER_GRACE_MS;
}

async function acquireInstallLock(lock) {
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!await lockIsStale(lock)) {
      throw new Error(`Another install operation owns ${lock}; check that process before removing a stale lock`, { cause: error });
    }
    await rm(lock, { recursive: true, force: true });
    try {
      await mkdir(lock);
    } catch (retryError) {
      // Another waiter claimed it between the removal and this mkdir.
      throw new Error(`Another install operation owns ${lock}; check that process before removing a stale lock`, { cause: retryError });
    }
  }
  await writeFile(ownerPath(lock), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

/** Build and validate off to the side before touching the current install.
 * A sibling stage keeps the final rename on the same filesystem. All writers
 * (install/update/rollback) share the lock. A live holder fails with its path;
 * a dead one is reclaimed, because its residue would otherwise block every
 * later install until a human removed it.
 */
export async function withInstallLock(dest, run) {
  await mkdir(dirname(dest), { recursive: true });
  const lock = `${dest}.install-lock`;
  await acquireInstallLock(lock);
  try {
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function stageAndPublishInstall(dest, { mode, build, retire, move = rename }) {
  return withInstallLock(dest, async () => {
    const present = await exists(dest);
    if (mode === "install" && present) throw new Error("Candidate install output already exists; choose a new directory or pass --update");
    if (mode === "update" && !present) throw new Error("Candidate update requires an existing install directory");
    if (mode !== "install" && mode !== "update") throw new Error(`Unknown install mode: ${mode}`);
    const scratch = await mkdtemp(join(dirname(dest), `.${basename(dest)}-stage-`));
    const staged = join(scratch, "candidate");
    const snapshot = `${dest}.previous`;
    const retiring = `${dest}.previous-retiring`;
    let movedPrevious = false;
    let movedStale = false;
    try {
      const result = await build(staged, present ? dest : null);
      // build() must finish validation and write its ready receipt before this.
      if (present) {
        // Hold the existing snapshot aside instead of retiring it now: until the
        // replacement is published it is the only restore point, and a failed
        // move below must still leave something to roll back to.
        if (await exists(retiring)) await retire(retiring);
        if (await exists(snapshot)) {
          await move(snapshot, retiring);
          movedStale = true;
        }
        try {
          await move(dest, snapshot);
        } catch (error) {
          if (movedStale) await move(retiring, snapshot);
          throw error;
        }
        movedPrevious = true;
      }
      try {
        await move(staged, dest);
      } catch (error) {
        if (movedPrevious) {
          try {
            await move(snapshot, dest);
            if (movedStale) await move(retiring, snapshot);
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], `Install publication and restoration failed; previous install is at ${snapshot}`);
          }
        }
        throw error;
      }
      // The new install is in place, so the superseded snapshot is now spare.
      if (movedStale) await retire(retiring);
      return result;
    } finally {
      // Never clean the current install or its previous snapshot on failure.
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
