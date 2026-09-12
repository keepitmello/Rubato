// Derived from Rubato's Senpi Cursor host mutation bridge. See THIRD_PARTY_NOTICES.md.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
  const settled = current.then(() => undefined, () => undefined);
  locks.set(path, settled);
  return current.finally(() => {
    if (locks.get(path) === settled) locks.delete(path);
  });
}

// Resolve an existing link before choosing the lock and rename destination.
// A dangling link must fail rather than silently replacing the link itself.
async function mutationPath(path, cwd) {
  const absolute = resolveSessionPath(path, cwd);
  try {
    await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return absolute;
    throw error;
  }
  return realpath(absolute);
}

async function commitHostBytes(path, expected) {
  const bytes = Buffer.from(expected);
  let mode = 0o600;
  try {
    const existing = await stat(path);
    if (!existing.isFile()) throw new Error(`Write target is not a regular file: ${path}`);
    mode = existing.mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.rubato-write-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, bytes, { mode, flag: "wx" });
    // writeFile applies umask. Restore the existing permission bits explicitly.
    await chmod(temporary, mode);
    await rename(temporary, path);
    const readback = await readFile(path);
    if (!readback.equals(bytes)) throw new Error(`Write did not persist to disk: ${path}`);
    return { path, bytes: bytes.length };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function hostWrite({ cwd, path, content, bytes } = {}) {
  const absolute = await mutationPath(path, cwd);
  const expected = expectedWriteBytes({ content, bytes });
  return withPathLock(absolute, () => commitHostBytes(absolute, expected));
}

export async function hostEdit({ cwd, path, edits } = {}) {
  const absolute = await mutationPath(path, cwd);
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

// A native executor is not a model-visible tool. The bridge supplies this
// trusted, in-memory definition to executeTool; validation and session hooks
// still run even when codemode has removed write/edit from the model's tools.
export function createNativeFileTool(name, cwd) {
  if (name !== "write" && name !== "edit") throw new TypeError("Native file tool must be write or edit");
  const path = { type: "string", minLength: 1 };
  const parameters = name === "write"
    ? { type: "object", properties: {
        path, content: { type: "string" },
        bytes: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } },
      }, required: ["path"], anyOf: [{ required: ["content"] }, { required: ["bytes"] }] }
    : { type: "object", properties: {
        path, edits: { type: "array", minItems: 1, items: {
          type: "object", properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } },
          required: ["oldText", "newText"],
        } },
      }, required: ["path", "edits"] };
  return {
    name,
    description: `Cursor native file ${name}`,
    parameters,
    // Transport bytes are not necessarily ordinary JS arrays. Normalize them
    // before the same schema validator used by registered tools sees them.
    prepareArguments: (args) => args?.bytes == null ? args : { ...args, bytes: Array.from(args.bytes) },
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const written = name === "write" ? await hostWrite({ cwd, ...args }) : await hostEdit({ cwd, ...args });
      return { content: [{ type: "text", text: `Successfully wrote ${written.bytes} bytes to ${args.path}` }] };
    },
  };
}
