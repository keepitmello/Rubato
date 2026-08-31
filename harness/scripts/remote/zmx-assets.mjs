#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const lockPath = join(repositoryRoot, "third_party", "zmx-lock.json");

export function readZmxLock(path = lockPath) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  if (lock.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(lock.commit)) {
    throw new Error("invalid zmx source lock");
  }
  for (const platform of Object.keys(lock.build?.targets ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(lock.assets?.[`zmx-${platform}`])) {
      throw new Error(`invalid zmx asset lock for ${platform}`);
    }
  }
  return lock;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyZmxAsset(path, expectedSha256) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new TypeError("expected SHA-256 must be 64 lowercase hex characters");
  const actual = sha256File(path);
  if (actual !== expectedSha256) throw new Error(`zmx checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  return actual;
}

export function buildPlan(lock, outputDirectory) {
  return Object.entries(lock.build.targets).map(([platform, target]) => ({
    platform,
    target,
    assetName: `zmx-${platform}`,
    outputPath: join(outputDirectory, `zmx-${platform}`),
  }));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

export function buildZmxAssets({ outputDirectory, workDirectory, lock = readZmxLock() }) {
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(workDirectory, { recursive: true });
  const source = join(workDirectory, "zmx");
  run("git", ["clone", "--filter=blob:none", lock.repository, source]);
  run("git", ["-C", source, "checkout", "--detach", lock.commit]);
  const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0 || head.stdout.trim() !== lock.commit) throw new Error("zmx checkout does not match source lock");
  const zig = spawnSync("zig", ["version"], { encoding: "utf8" });
  if (zig.status !== 0 || !zig.stdout.trim().startsWith("0.16.")) throw new Error("zmx build requires Zig 0.16.x");

  const assets = {};
  for (const item of buildPlan(lock, outputDirectory)) {
    const prefix = join(workDirectory, `out-${item.platform}`);
    const cache = join(workDirectory, `cache-${item.platform}`);
    run("zig", [
      "build",
      `-Dtarget=${item.target}`,
      `-Doptimize=${lock.build.optimize}`,
      "--prefix",
      prefix,
      "--cache-dir",
      cache,
    ], { cwd: source });
    const built = join(prefix, "bin", "zmx");
    copyFileSync(built, item.outputPath);
    chmodSync(item.outputPath, 0o755);
    const sha256 = verifyZmxAsset(item.outputPath, lock.assets[item.assetName]);
    assets[item.platform] = {
      file: basename(item.outputPath),
      sha256,
    };
  }
  const manifest = {
    schemaVersion: 1,
    sourceCommit: lock.commit,
    buildTool: lock.buildTool,
    assets,
  };
  writeFileSync(join(outputDirectory, "zmx-assets.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === "verify") {
    if (!first || !second) throw new Error("usage: zmx-assets.mjs verify <asset> <sha256>");
    verifyZmxAsset(first, second);
    return;
  }
  if (command === "build") {
    if (!first) throw new Error("usage: zmx-assets.mjs build <output-directory> [work-directory]");
    const outputDirectory = resolve(first);
    const workDirectory = resolve(second ?? join(outputDirectory, ".work"));
    buildZmxAssets({ outputDirectory, workDirectory });
    return;
  }
  throw new Error("usage: zmx-assets.mjs <build|verify> ...");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`zmx-assets: ${error.message}`);
    process.exit(1);
  }
}
