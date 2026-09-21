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
// test cannot escape the sweep by forgetting to register. Entries newer than
// the grace period are left alone, so a concurrent run is never disturbed.

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_GRACE_MS = 2 * 60 * 60 * 1000;

// `isolateHome(prefix)` takes its prefix from the caller, so the call sites are
// the only place the literal appears.
const PREFIX_PATTERNS = [
  /mkdtemp(?:Sync)?\(\s*join\(\s*tmpdir\(\)\s*,\s*"([^"]+)"/g,
  /isolateHome\(\s*"([^"]+)"/g,
];

// Roots that live in the temp directory without being created by mkdtemp.
const EXTRA_PREFIXES = ["rubato-isolated-trash"];

async function collectPrefixes(dir, prefixes = new Set()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectPrefixes(path, prefixes);
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    const text = await readFile(path, "utf8");
    for (const pattern of PREFIX_PATTERNS) {
      for (const match of text.matchAll(pattern)) prefixes.add(match[1]);
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

async function main() {
  const { graceMs, dryRun } = parseArgs(process.argv.slice(2));
  const prefixes = [...new Set([...await collectPrefixes(root), ...EXTRA_PREFIXES])];
  if (prefixes.length === 0) throw new Error(`No scratch prefixes found under ${root}`);

  const temp = tmpdir();
  const cutoff = Date.now() - graceMs;
  const removed = [];
  const skipped = [];

  for (const entry of await readdir(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(temp, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.mtimeMs > cutoff) {
      skipped.push(entry.name);
      continue;
    }
    if (!dryRun) await rm(path, { recursive: true, force: true });
    removed.push(entry.name);
  }

  const verb = dryRun ? "would remove" : "removed";
  process.stdout.write(`sweep-scratch: ${verb} ${removed.length} stale scratch dir(s) of ${prefixes.length} known prefixes in ${temp}\n`);
  if (skipped.length > 0) {
    process.stdout.write(`sweep-scratch: kept ${skipped.length} dir(s) younger than ${Math.round(graceMs / 1000)}s (a run may be in flight)\n`);
  }
}

await main();
