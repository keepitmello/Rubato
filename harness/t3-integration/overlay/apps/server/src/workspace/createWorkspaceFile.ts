// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Create, never overwrite. Do not follow directory links out of the repository. */
export async function createWorkspaceFile(
  cwd: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const relative = relativePath.replaceAll("\\", "/");
  const segments = relative.split("/");
  if (
    path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) ||
    segments.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Choose a file path inside this repository.");
  }
  let directory = await fs.realpath(cwd);
  for (const part of segments.slice(0, -1)) {
    const next = path.join(directory, part);
    try {
      await fs.mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(next);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Choose a folder in this repository, not a linked folder.");
    }
    directory = next;
  }
  try {
    await fs.writeFile(path.join(directory, segments.at(-1)!), contents, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("A file already exists at this path. Choose another name.");
    }
    throw error;
  }
}
