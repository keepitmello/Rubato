#!/usr/bin/env node
// Removes scratch directories the test suite left behind in the system temp
// directory.
//
// Tests create their scratch space with `mkdtemp(join(tmpdir(), prefix))` and
// remove it from an `after()`/`t.after()` hook. That hook never runs when the
// test process is killed, and `--test-timeout` kills a test process that
// overruns its budget, so a loaded runner leaves directories behind that no
// later run revisits. Sweeping before a run keeps the temp directory from
// growing without bound.
//
// Prefixes are read from the sources instead of being listed here, so a new
// test cannot escape the sweep by forgetting to register. Every package mints
// scratch dirs, so the scan covers the whole repo rather than one package.
// Entries newer than the grace period are left alone, so a concurrent run is
// never disturbed.

import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "../pi-runtime/scripts/payload-lock.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_GRACE_MS = 2 * 60 * 60 * 1000;

const SCAN_ROOTS = ["harness", "packages"];
const SCAN_EXTENSIONS = [".mjs", ".js", ".ts", ".sh"];

// The same `join(tmpdir(), "...")` shape also names single files and one-off
// directories. A scratch prefix is minted to be suffixed with mkdtemp's random
// characters, so it ends in a separator; anything else has to be long enough to
// be unmistakable before the sweep will match on it. Without this, a literal
// like `join(tmpdir(), "project")` would let the sweep delete unrelated
// directories whose names happen to start with `project`.
const MIN_BARE_PREFIX_LENGTH = 12;

function isScratchPrefix(name) {
  if (name.length === 0 || /[\s/\\]/.test(name)) return false;
  if (/\.[a-z0-9]+$/i.test(name)) return false;
  return name.endsWith("-") || name.length >= MIN_BARE_PREFIX_LENGTH;
}

// `isolateHome(prefix)` takes its prefix from the caller, so the call sites are
// the only place the literal appears.
const PREFIX_PATTERNS = [
  /(?:join|path\.join)\(\s*tmpdir\(\)\s*,\s*"([^"]+)"/g,
  /isolateHome\(\s*"([^"]+)"/g,
];

// Roots that collect children for as long as anything keeps retiring into them
// rather than being created once per run. Their own mtime tracks the last child
// added, so a plain age check on the directory never fires; age the children.
const CONTAINER_PREFIXES = ["rubato-isolated-trash"];

async function collectPrefixes(dir, prefixes = new Set()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectPrefixes(path, prefixes);
      continue;
    }
    if (!SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    const text = await readFile(path, "utf8");
    for (const pattern of PREFIX_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        if (isScratchPrefix(match[1])) prefixes.add(match[1]);
      }
    }
  }
  return prefixes;
}

function parseArgs(argv) {
  const options = { graceMs: DEFAULT_GRACE_MS, dryRun: false };
  for (const arg of argv) {
    if (arg === "--all") options.graceMs = 0;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--grace-ms=")) {
      const value = Number(arg.slice("--grace-ms=".length));
      if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --grace-ms: ${arg}`);
      options.graceMs = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// A container root is swept by the age of its children, then dropped once it is
// empty. Ageing the container itself would never fire while anything keeps
// retiring into it.
async function sweepContainer(path, name, { cutoff, dryRun, removed, skipped }) {
  for (const child of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const childPath = join(path, child.name);
    const info = await stat(childPath).catch(() => undefined);
    if (!info) continue;
    if (info.mtimeMs > cutoff) {
      skipped.push(`${name}/${child.name}`);
      continue;
    }
    if (!dryRun) await removeTree(childPath).catch(() => {});
    removed.push(`${name}/${child.name}`);
  }
  if (dryRun) return;
  const left = await readdir(path).catch(() => undefined);
  if (left?.length === 0) {
    await removeTree(path).catch(() => {});
    removed.push(name);
  }
}

async function main() {
  const { graceMs, dryRun } = parseArgs(process.argv.slice(2));
  const prefixes = new Set(CONTAINER_PREFIXES);
  for (const scanRoot of SCAN_ROOTS) await collectPrefixes(join(repo, scanRoot), prefixes);
  if (prefixes.size <= CONTAINER_PREFIXES.length) throw new Error(`No scratch prefixes found under ${repo}`);

  const temp = tmpdir();
  const cutoff = Date.now() - graceMs;
  const removed = [];
  const skipped = [];

  for (const entry of await readdir(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (![...prefixes].some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(temp, entry.name);
    if (CONTAINER_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      await sweepContainer(path, entry.name, { cutoff, dryRun, removed, skipped });
      continue;
    }
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.mtimeMs > cutoff) {
      skipped.push(entry.name);
      continue;
    }
    if (!dryRun) await removeTree(path).catch(() => {});
    removed.push(entry.name);
  }

  const verb = dryRun ? "would remove" : "removed";
  process.stdout.write(`sweep-scratch: ${verb} ${removed.length} stale scratch dir(s) of ${prefixes.size} known prefixes in ${temp}\n`);
  if (skipped.length > 0) {
    process.stdout.write(`sweep-scratch: kept ${skipped.length} dir(s) younger than ${Math.round(graceMs / 1000)}s (a run may be in flight)\n`);
  }
}

await main();
