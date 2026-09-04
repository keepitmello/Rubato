import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Resolve a write/edit path against the session cwd, not the process cwd.
 * The session may be in any repo; process.cwd() is not that repo.
 */
export function resolveHostPath(path, cwd = process.cwd()) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Write did not persist to disk: missing path");
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function applyUniqueEdits(text, edits) {
  if (typeof text !== "string") {
    throw new Error("Edit did not persist to disk: missing file text");
  }
  let next = text;
  for (const edit of edits ?? []) {
    const oldText = edit?.oldText ?? edit?.old_string;
    const newText = edit?.newText ?? edit?.new_string;
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new Error("Edit did not persist to disk: invalid replacement");
    }
    const start = next.indexOf(oldText);
    if (start === -1 || next.indexOf(oldText, start + oldText.length) !== -1) {
      throw new Error("Edit did not persist to disk: replacement must match exactly once");
    }
    next = `${next.slice(0, start)}${newText}${next.slice(start + oldText.length)}`;
  }
  return next;
}

export async function readEditFinalContent(path, edits, cwd = process.cwd()) {
  const absolute = resolveHostPath(path, cwd);
  const current = await readFile(absolute, "utf8");
  return applyUniqueEdits(current, edits);
}

/**
 * The host disk is the source of truth for Cursor write frames.
 * Tool-layer success is not enough: this writes, fsyncs, and reads back.
 * `cwd` is the session working directory so a relative path lands in
 * whichever repo the session is in.
 */
export async function persistWriteToHostDisk(path, content, cwd = process.cwd()) {
  if (typeof content !== "string") {
    throw new Error(`Write did not persist to disk: ${path}`);
  }
  const absolute = resolveHostPath(path, cwd);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.rubato-write-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, absolute);
  const readback = await readFile(absolute, "utf8");
  if (readback !== content) {
    throw new Error(`Write did not persist to disk: ${path}`);
  }
  return absolute;
}

export async function persistEditToHostDisk(path, edits, cwd = process.cwd()) {
  const content = await readEditFinalContent(path, edits, cwd);
  return persistWriteToHostDisk(path, content, cwd);
}
