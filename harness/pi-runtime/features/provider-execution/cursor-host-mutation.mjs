// Derived from Rubato's Senpi Cursor host mutation bridge. See THIRD_PARTY_NOTICES.md.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const locks = new Map();

export function resolveSessionPath(path, cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("Write did not persist to disk: missing session cwd");
  }
  if (typeof path !== "string" || path === "") {
    throw new Error("Write did not persist to disk: missing path");
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function expectedWriteBytes({ content, bytes } = {}) {
  if (bytes != null && bytes.length > 0) return Buffer.from(bytes);
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (bytes != null) return Buffer.from(bytes);
  throw new Error("Write did not persist to disk: missing file text");
}

export function applyUniqueEdits(text, edits) {
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

function withPathLock(path, task) {
  const previous = locks.get(path) ?? Promise.resolve();
  const current = previous.then(task, task);
  locks.set(path, current.then(() => undefined, () => undefined));
  return current.finally(() => {
    if (locks.get(path) === current) locks.delete(path);
  });
}

async function commitHostBytes(path, expected) {
  const bytes = Buffer.from(expected);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.rubato-write-${process.pid}-${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
  const readback = await readFile(path);
  if (!readback.equals(bytes)) throw new Error(`Write did not persist to disk: ${path}`);
  return { path, bytes: bytes.length };
}

export async function hostWrite({ cwd, path, content, bytes } = {}) {
  const absolute = resolveSessionPath(path, cwd);
  const expected = expectedWriteBytes({ content, bytes });
  return withPathLock(absolute, () => commitHostBytes(absolute, expected));
}

export async function hostEdit({ cwd, path, edits } = {}) {
  const absolute = resolveSessionPath(path, cwd);
  return withPathLock(absolute, async () => {
    let current;
    try {
      current = await readFile(absolute, "utf8");
    } catch {
      throw new Error(`Edit did not persist to disk: ${path}`);
    }
    const expected = Buffer.from(applyUniqueEdits(current, edits), "utf8");
    return commitHostBytes(absolute, expected);
  });
}
