import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

// Build inputs, not installed dependencies or generated bundles. Path names and
// executable bits participate so renames/removals are changes too.
const ROOTS = ["package.json", "bun.lock", "harness", "packages"];
const IGNORE = new Set(["node_modules", ".git", "dist", ".build", ".cache", "coverage", ".DS_Store"]);

export async function sourceFingerprint(repoRoot) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const path = join(repoRoot, relative);
    let entry;
    try { entry = await lstat(path); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update(`missing\0${relative}\0`);
      return;
    }
    if (entry.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (!IGNORE.has(name)) await visit(`${relative}/${name}`);
      }
    } else if (entry.isSymbolicLink()) {
      hash.update(`link\0${relative}\0${await readlink(path)}\0`);
    } else if (entry.isFile()) {
      hash.update(`file\0${relative}\0${entry.mode & 0o111}\0`);
      hash.update(await readFile(path));
      hash.update("\0");
    }
  }
  for (const path of ROOTS) await visit(path);
  return hash.digest("hex");
}
