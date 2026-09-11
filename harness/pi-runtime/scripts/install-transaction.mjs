import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const exists = (path) => lstat(path).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

/** Build and validate off to the side before touching the current install.
 * A sibling stage keeps the final rename on the same filesystem. All writers
 * (install/update/rollback) share the lock; a stale lock fails with its path.
 */
export async function withInstallLock(dest, run) {
  await mkdir(dirname(dest), { recursive: true });
  const lock = `${dest}.install-lock`;
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another install operation owns ${lock}; check that process before removing a stale lock`, { cause: error });
    throw error;
  }
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
    let movedPrevious = false;
    try {
      const result = await build(staged, present ? dest : null);
      // build() must finish validation and write its ready receipt before this.
      if (present) {
        if (await exists(snapshot)) await retire(snapshot);
        await move(dest, snapshot);
        movedPrevious = true;
      }
      try {
        await move(staged, dest);
      } catch (error) {
        if (movedPrevious) {
          try {
            await move(snapshot, dest);
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], `Install publication and restoration failed; previous install is at ${snapshot}`);
          }
        }
        throw error;
      }
      return result;
    } finally {
      // Never clean the current install or its previous snapshot on failure.
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
