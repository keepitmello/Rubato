import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withInstallLock } from "../scripts/install-transaction.mjs";

const OWNER_FILE = "owner.json";

async function scratchDest(t) {
  const root = await mkdtemp(join(tmpdir(), "rubato-install-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "engine");
}

async function dirExists(path) {
  return utimes(path, new Date(), new Date()).then(() => true, () => false);
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

test("#given a lock owned by a live pid #when an install starts #then it refuses and keeps the lock", async (t) => {
  const dest = await scratchDest(t);
  const lock = `${dest}.install-lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, OWNER_FILE), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  await assert.rejects(withInstallLock(dest, async () => "ran"), /Another install operation owns/);
  assert.equal(await dirExists(lock), true, "a live holder's lock must survive");
});

test("#given a lock left by a dead install #when an install starts #then the residue is reclaimed", async (t) => {
  const dest = await scratchDest(t);
  const lock = `${dest}.install-lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, OWNER_FILE), JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));

  assert.equal(await withInstallLock(dest, async () => "ran"), "ran");
});

test("#given an ownerless lock older than the write gap #when an install starts #then it is treated as residue", async (t) => {
  const dest = await scratchDest(t);
  const lock = `${dest}.install-lock`;
  await mkdir(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);

  assert.equal(await withInstallLock(dest, async () => "ran"), "ran");
});

test("#given an ownerless lock from this instant #when an install starts #then it refuses", async (t) => {
  const dest = await scratchDest(t);
  await mkdir(`${dest}.install-lock`, { recursive: true });

  await assert.rejects(withInstallLock(dest, async () => "ran"), /Another install operation owns/);
});

test("#given a holder mid-run #when the lock is read #then it names the holder and is gone afterwards", async (t) => {
  const dest = await scratchDest(t);
  const lock = `${dest}.install-lock`;
  let owner;
  await withInstallLock(dest, async () => {
    owner = JSON.parse(await readFile(join(lock, OWNER_FILE), "utf8"));
  });

  assert.equal(owner.pid, process.pid);
  assert.equal(await dirExists(lock), false, "a released lock must be gone");
});
