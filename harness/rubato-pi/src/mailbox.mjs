import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DELIVERING_PREFIX = ".delivering-";
const JSON_SUFFIX = ".json";

export function inboxDir(stateDir, teamRunId, memberName) {
  return join(stateDir, "runtime", teamRunId, "inboxes", memberName);
}

export function mailboxPaths(dir, messageId) {
  return {
    inboxPath: join(dir, `${messageId}${JSON_SUFFIX}`),
    reservedPath: join(dir, `${DELIVERING_PREFIX}${messageId}${JSON_SUFFIX}`),
    processedDir: join(dir, "processed"),
    processedPath: join(dir, "processed", `${messageId}${JSON_SUFFIX}`),
  };
}

export async function isProcessed(dir, messageId) {
  try {
    await stat(mailboxPaths(dir, messageId).processedPath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function claimInbox(dir, messageId) {
  if (await isProcessed(dir, messageId)) return { kind: "already_processed" };
  const paths = mailboxPaths(dir, messageId);
  try {
    await rename(paths.inboxPath, paths.reservedPath);
    return { kind: "claimed", paths };
  } catch (error) {
    if (error && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

export async function commitDelivery(paths) {
  await mkdir(paths.processedDir, { recursive: true });
  await rename(paths.reservedPath, paths.processedPath);
}

export async function rollbackDelivery(paths) {
  await rename(paths.reservedPath, paths.inboxPath);
}

export async function reclaimStaleReserved(dir, staleAfterMs, now = Date.now()) {
  const { readdir } = await import("node:fs/promises");
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const reclaimed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(DELIVERING_PREFIX) || !entry.name.endsWith(JSON_SUFFIX)) {
      continue;
    }
    const reservedPath = join(dir, entry.name);
    const info = await stat(reservedPath);
    // APFS (and other high-res clocks) can stamp mtime slightly ahead of Date.now().
    // Treat a future mtime as age 0 so staleAfterMs=0 means "reclaim all" instead of
    // skipping the file we just reserved. Shared-state reclaim must not depend on luck.
    const age = Math.max(0, now - info.mtimeMs);
    if (age < staleAfterMs) continue;
    const messageId = entry.name.slice(DELIVERING_PREFIX.length, -JSON_SUFFIX.length);
    await rename(reservedPath, join(dir, `${messageId}${JSON_SUFFIX}`));
    reclaimed.push(messageId);
  }
  return reclaimed;
}

export async function writeInbox(dir, messageId, payload) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${messageId}${JSON_SUFFIX}`), `${JSON.stringify(payload)}\n`);
}
