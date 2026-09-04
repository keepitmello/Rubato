import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * The host disk is the source of truth for Cursor write frames.
 * Tool-layer success is not enough: this writes, fsyncs, and reads back.
 */
export async function persistWriteToHostDisk(path, content, cwd = process.cwd()) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Write did not persist to disk: missing path");
  }
  if (typeof content !== "string") {
    throw new Error(`Write did not persist to disk: ${path}`);
  }
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
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
