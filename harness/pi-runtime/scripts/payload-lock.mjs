// The published candidate is a hash-checked snapshot. A later in-place copy
// keeps the receipt and changes the bytes, so the next profile start refuses
// to boot. Darwin's user-immutable flag rejects that copy. Directory rename
// still publishes a replacement, which is how install and rollback move a tree.
import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const STAGE_RECEIPT = "rubato-pi-stage.json";
const INSTALL_RECEIPT = "rubato-install.json";

export function payloadLockSupported(platform = process.platform) {
  return platform === "darwin";
}

function receiptPaths(stage) {
  const listed = [
    STAGE_RECEIPT,
    INSTALL_RECEIPT,
    "package.json",
    "package-lock.json",
    ...(stage.files ?? []).map((entry) => entry.path),
    ...(stage.addedFiles ?? []).map((entry) => entry.path),
    ...(stage.binShims ?? []).map((entry) => entry.path),
  ];
  return [...new Set(listed)];
}

async function existingPayload(root, paths) {
  const found = [];
  for (const rel of paths) {
    if (typeof rel !== "string" || rel.length === 0) throw new Error("Candidate payload lock record is missing a path");
    const abs = join(root, rel);
    try {
      await lstat(abs);
    } catch (error) {
      if (error?.code === "ENOENT" && (rel === INSTALL_RECEIPT)) continue;
      throw new Error(`Candidate payload lock is missing ${rel}`, { cause: error });
    }
    found.push(abs);
  }
  return found;
}

/** `immutable` true sets `uchg`; false clears it. Non-darwin installs stay writable. */
export async function setPublishedPayloadImmutable(root, immutable) {
  if (!payloadLockSupported()) return { locked: false, count: 0 };
  const stage = JSON.parse(await readFile(join(root, STAGE_RECEIPT), "utf8"));
  const files = await existingPayload(root, receiptPaths(stage));
  const flag = immutable ? "uchg" : "nouchg";
  for (let i = 0; i < files.length; i += 80) {
    await run("chflags", [flag, ...files.slice(i, i + 80)]);
  }
  return { locked: Boolean(immutable), count: files.length };
}

export function lockPublishedPayload(root) {
  return setPublishedPayloadImmutable(root, true);
}

export function unlockPublishedPayload(root) {
  return setPublishedPayloadImmutable(root, false);
}

/**
 * Removes a tree, clearing Darwin's user-immutable flag when that is what
 * blocks the delete.
 *
 * A published payload carries `uchg` on its receipts and lockfile, so a plain
 * recursive delete fails with EPERM on every retired engine. Callers that
 * only want the tree gone should not have to know that.
 */
export async function removeTree(path) {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!payloadLockSupported()) throw error;
    await run("chflags", ["-R", "nouchg", path]).catch(() => {});
    await rm(path, { recursive: true, force: true });
  }
}
