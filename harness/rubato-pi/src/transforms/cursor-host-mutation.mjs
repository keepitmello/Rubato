import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const locks = new Map();

export function requireSessionCwd(cwd) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new Error("Write did not persist to disk: missing session cwd");
  }
  return cwd;
}

export function resolveSessionPath(path, cwd) {
  requireSessionCwd(cwd);
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Write did not persist to disk: missing path");
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function expectedWriteBytes({ content, bytes } = {}) {
  if (bytes != null) return Buffer.from(bytes);
  if (typeof content === "string") return Buffer.from(content, "utf8");
  throw new Error("Write did not persist to disk: missing file text (fileText/contents/content/fileBytes)");
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

function withPathLock(absolute, fn) {
  const previous = locks.get(absolute) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  locks.set(
    absolute,
    current.then(
      () => {},
      () => {},
    ),
  );
  return current;
}

export async function commitHostBytes(absolute, expected) {
  const bytes = Buffer.from(expected);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.rubato-write-${process.pid}-${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, bytes);
  await rename(temporary, absolute);
  const readback = await readFile(absolute);
  if (!Buffer.from(readback).equals(bytes)) {
    throw new Error(`Write did not persist to disk: ${absolute}`);
  }
  return absolute;
}

export async function hostWrite({ cwd, path, content, bytes } = {}) {
  const absolute = resolveSessionPath(path, cwd);
  const expected = expectedWriteBytes({ content, bytes });
  await withPathLock(absolute, () => commitHostBytes(absolute, expected));
  return { path: absolute, bytes: expected.length };
}

export async function hostEdit({ cwd, path, edits } = {}) {
  const absolute = resolveSessionPath(path, cwd);
  return withPathLock(absolute, async () => {
    let current;
    try {
      current = await readFile(absolute);
    } catch {
      throw new Error(`Edit did not persist to disk: ${path}`);
    }
    const next = applyUniqueEdits(current.toString("utf8"), edits);
    const expected = Buffer.from(next, "utf8");
    await commitHostBytes(absolute, expected);
    return { path: absolute, bytes: expected.length };
  });
}
