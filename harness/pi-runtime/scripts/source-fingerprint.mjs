import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// Build inputs, not installed dependencies or generated bundles. Path names and
// executable bits participate so renames/removals are changes too.
const ROOTS = ["package.json", "bun.lock", "harness", "packages"];
const IGNORE = new Set(["node_modules", ".git", "dist", ".build", ".cache", "coverage", ".DS_Store"]);

/** Whole-tree fingerprint. Receipts written before sourceInputs existed are compared with this. */
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

// What one engine build consumes (sourceInputs in the install receipt):
// - trees: the pi-runtime source. The build's own scripts and every feature
//   module run inside the installing process, some features list their files by
//   walking a directory, and npm ci reads its manifest and lock from here. Tests
//   and fixtures are left out; if a build does load or copy one, it is also in
//   `files` and counts there.
// - files: exact repo files the build read elsewhere — Bun metafile inputs, files
//   staged by sourcePath (including template-string sources()), modules the build
//   process resolved, and config Bun or TypeScript may consult without listing it.
// - the remote protocol package: loading the remote-surface feature runs its own
//   `bun build` over packages/rubato-remote-protocol/src
//   (features/remote-surface/protocol-loader.mjs materializeProtocolBundle), a
//   subprocess no metafile or module hook of this build sees.
// An edit anywhere else (a skill, a test, the T3 overlay) is not a build input.
export const SOURCE_INPUTS_VERSION = 1;
export const SOURCE_TREES = Object.freeze(["harness/pi-runtime", "packages/rubato-remote-protocol"]);
const TREE_SKIP = new Set([...IGNORE, "test", "tests", "test-fixtures", "__fixtures__"]);
const isTestFile = (name) => /\.test\.[cm]?[jt]sx?$/.test(name);
const CONFIG_NAMES = ["package.json", "bunfig.toml", "tsconfig.json", "tsconfig.base.json"];

const portable = (path) => path.split(sep).join("/");
function repoRelative(repoRoot, path) {
  const rel = portable(relative(repoRoot, path));
  return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? rel : null;
}

async function entryOf(repoRoot, rel) {
  let info;
  try { info = await lstat(join(repoRoot, rel)); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return `missing\0${rel}`;
    throw error;
  }
  if (info.isSymbolicLink()) return `link\0${rel}\0${await readlink(join(repoRoot, rel))}`;
  if (!info.isFile()) return `other\0${rel}`;
  const digest = createHash("sha256").update(await readFile(join(repoRoot, rel))).digest("hex");
  return `file\0${rel}\0${info.mode & 0o111}\0${digest}`;
}

async function treeFiles(repoRoot, tree) {
  const files = [];
  async function visit(rel) {
    let info;
    try { info = await lstat(join(repoRoot, rel)); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory()) { files.push(rel); return; }
    for (const name of await readdir(join(repoRoot, rel))) {
      if (TREE_SKIP.has(name) || isTestFile(name)) continue;
      await visit(`${rel}/${name}`);
    }
  }
  await visit(tree);
  return files;
}

async function configFiles(repoRoot) {
  const files = [...CONFIG_NAMES, "bun.lock"];
  const packages = await readdir(join(repoRoot, "packages"), { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const dir of packages) if (dir.isDirectory()) for (const name of CONFIG_NAMES) files.push(`packages/${dir.name}/${name}`);
  return files;
}

/** The receipt's input spec from what a finished build read. Paths outside the repo are not source. */
export async function describeSourceInputs(repoRoot, paths) {
  const files = new Set(await configFiles(repoRoot));
  const real = await realpath(repoRoot);
  for (const path of paths) {
    const rel = isAbsolute(path) ? repoRelative(repoRoot, path) ?? repoRelative(real, path) : repoRelative(repoRoot, join(repoRoot, path));
    // Installed dependencies follow their manifest and lock, which the tree covers.
    if (rel && !rel.split("/").some((part) => IGNORE.has(part))) files.add(rel);
  }
  return { version: SOURCE_INPUTS_VERSION, trees: [...SOURCE_TREES], files: [...files].sort() };
}

function digestEntries(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry}\0\n`);
  return hash.digest("hex");
}

/** Fingerprint of exactly the inputs a receipt names, read from disk now. */
export async function inputFingerprint(repoRoot, inputs) {
  if (inputs?.version !== SOURCE_INPUTS_VERSION || !Array.isArray(inputs.trees) || !Array.isArray(inputs.files)) return null;
  const paths = new Set(inputs.files);
  for (const tree of inputs.trees) for (const rel of await treeFiles(repoRoot, tree)) paths.add(rel);
  const entries = [];
  for (const rel of [...paths].sort()) entries.push(await entryOf(repoRoot, rel));
  return digestEntries(entries);
}

/** Every candidate input as it was when a build started; see inputFingerprint. */
export async function snapshotSources(repoRoot) {
  const entries = new Map();
  const trees = new Map();
  for (const tree of SOURCE_TREES) trees.set(tree, await treeFiles(repoRoot, tree));
  async function visit(rel) {
    let info;
    try { info = await lstat(join(repoRoot, rel)); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(join(repoRoot, rel))) if (!IGNORE.has(name)) await visit(rel ? `${rel}/${name}` : name);
      return;
    }
    entries.set(rel, await entryOf(repoRoot, rel));
  }
  for (const root of ROOTS) await visit(root);
  for (const dir of await readdir(repoRoot, { withFileTypes: true })) {
    if (!dir.isDirectory() && !entries.has(dir.name)) entries.set(dir.name, await entryOf(repoRoot, dir.name));
  }
  return { entries, trees, covers: (rel) => ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`)) || !rel.includes("/") };
}

/** The same fingerprint as inputFingerprint, computed from a snapshot taken before the build. */
export function snapshotFingerprint(snapshot, inputs) {
  const paths = new Set(inputs.files);
  for (const tree of inputs.trees) {
    const files = snapshot.trees.get(tree);
    if (!files) throw new Error(`Build input tree was not snapshotted: ${tree}`);
    for (const rel of files) paths.add(rel);
  }
  const entries = [];
  for (const rel of [...paths].sort()) {
    if (!snapshot.covers(rel)) throw new Error(`Build read a source outside the snapshotted roots: ${rel}`);
    entries.push(snapshot.entries.get(rel) ?? `missing\0${rel}`);
  }
  return digestEntries(entries);
}

/** Inputs whose content differs between the start snapshot and disk, for the abort message. */
export async function changedInputs(repoRoot, snapshot, inputs) {
  const paths = new Set(inputs.files);
  for (const tree of inputs.trees) {
    for (const rel of snapshot.trees.get(tree) ?? []) paths.add(rel);
    for (const rel of await treeFiles(repoRoot, tree)) paths.add(rel);
  }
  const changed = [];
  for (const rel of [...paths].sort()) {
    if ((snapshot.entries.get(rel) ?? `missing\0${rel}`) !== await entryOf(repoRoot, rel)) changed.push(rel);
  }
  return changed;
}
