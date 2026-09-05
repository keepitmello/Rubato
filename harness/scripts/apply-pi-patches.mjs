#!/usr/bin/env node
// Stage-copy stock Pi 0.84.2 packages, apply owned patches in manifest order,
// publish only a fully verified tree. Never writes the caller's source.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(here, "..", "..");
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];
const PATCH_FAIL_RE = /offset|hunks failed|failed while patching|previously applied|fuzz [1-9]/i;

export class ApplyPiPatchesError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApplyPiPatchesError";
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function existingRealpath(path) {
  let cur = path;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return path;
    cur = parent;
  }
  return realpathSync(cur);
}

function resolveIntended(path) {
  const missing = [];
  let cur = path;
  while (!existsSync(cur)) {
    missing.unshift(basename(cur));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return missing.length === 0 ? base : join(base, ...missing);
}

function mkdirExclusive(dir, label) {
  const parent = dirname(dir);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new ApplyPiPatchesError(`${label} already exists: ${dir}`);
    }
    throw error;
  }
}

function assertDistinct(labelA, pathA, labelB, pathB) {
  const a = resolveIntended(pathA);
  const b = resolveIntended(pathB);
  if (a === b || isInside(a, b) || isInside(b, a)) {
    throw new ApplyPiPatchesError(`${labelA} and ${labelB} overlap (${a} vs ${b})`);
  }
}

function assertContained(label, path, ...forbiddenRoots) {
  const real = existingRealpath(path);
  for (const root of forbiddenRoots) {
    if (!root) continue;
    const rootReal = existingRealpath(root);
    if (isInside(real, rootReal)) {
      throw new ApplyPiPatchesError(`${label} ${path} resolves inside ${root} (realpath ${real})`);
    }
  }
}

function readContainedFile(packageRoot, rel) {
  const abs = join(packageRoot, rel);
  if (!existsSync(abs)) {
    throw new ApplyPiPatchesError(`missing ${rel} under ${packageRoot}`);
  }
  const rootReal = realpathSync(packageRoot);
  const fileReal = realpathSync(abs);
  if (!isInside(fileReal, rootReal)) {
    throw new ApplyPiPatchesError(`${rel} escapes package root ${packageRoot} -> ${fileReal}`);
  }
  return readFileSync(fileReal);
}

function writeFileBytes(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    throw new ApplyPiPatchesError(`refusing to write through symlink ${dest}`);
  }
  writeFileSync(dest, buf);
}

function loadManifest(repoRoot) {
  const path = join(repoRoot, "harness", "pi-patches", "manifest.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function validatePackageSource(spec, sourceRoot) {
  const pkg = JSON.parse(readContainedFile(sourceRoot, "package.json").toString("utf8"));
  if (pkg.name !== spec.name || pkg.version !== spec.version) {
    throw new ApplyPiPatchesError(
      `package identity mismatch at ${sourceRoot}: ${pkg.name}@${pkg.version} != ${spec.name}@${spec.version}`,
    );
  }
  for (const file of spec.files) {
    if (file.sha256 === null) {
      const root = realpathSync(sourceRoot);
      if (typeof file.path !== "string" || !file.path || isAbsolute(file.path) ||
          !isInside(join(root, file.path), root) ||
          !isInside(existingRealpath(dirname(join(root, file.path))), root)) {
        throw new ApplyPiPatchesError(`new file escapes package root: ${file.path}`);
      }
      if (!/^[a-f0-9]{64}$/i.test(file.postimageSha256 ?? "")) {
        throw new ApplyPiPatchesError(`new file requires postimage SHA256: ${file.path}`);
      }
      try {
        lstatSync(join(root, file.path));
        throw new ApplyPiPatchesError(`expected absent source file: ${file.path}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      continue;
    }
    const buf = readContainedFile(sourceRoot, file.path);
    const digest = sha256(buf);
    if (digest !== file.sha256) {
      throw new ApplyPiPatchesError(
        `pristine digest mismatch ${spec.id}:${file.path} got ${digest} want ${file.sha256}`,
      );
    }
  }
}

function stagePackage(spec, sourceRoot, stagePkg) {
  mkdirSync(stagePkg, { recursive: true });
  for (const file of spec.files) {
    if (file.sha256 === null) continue;
    writeFileBytes(join(stagePkg, file.path), readContainedFile(sourceRoot, file.path));
  }
}

function applyPatchFile(stagePkg, patchAbs) {
  const result = spawnSync("patch", [...PATCH_FLAGS, "-i", patchAbs], {
    cwd: stagePkg,
    encoding: "utf8",
    timeout: PATCH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    throw new ApplyPiPatchesError(`patch timed out or killed (${result.signal ?? "timeout"}): ${patchAbs}`);
  }
  if (result.status !== 0) {
    throw new ApplyPiPatchesError(`patch failed (${result.status}) ${patchAbs}: ${out}`);
  }
  if (PATCH_FAIL_RE.test(out)) {
    throw new ApplyPiPatchesError(`patch not a clean fuzz-0 apply ${patchAbs}: ${out}`);
  }
}

function verifyPostimage(spec, stagePkg) {
  for (const file of spec.files) {
    const want = file.postimageSha256 ?? file.sha256;
    const digest = sha256(readFileSync(join(stagePkg, file.path)));
    if (digest !== want) {
      throw new ApplyPiPatchesError(
        `postimage digest mismatch ${spec.id}:${file.path} got ${digest} want ${want}`,
      );
    }
  }
}

function publishPackage(spec, stagePkg, publishPkg) {
  mkdirSync(publishPkg, { recursive: true });
  for (const file of spec.files) {
    writeFileBytes(join(publishPkg, file.path), readFileSync(join(stagePkg, file.path)));
  }
}

/**
 * @param {{
 *   codingAgentSource: string,
 *   tuiSource: string,
 *   stageDir: string,
 *   publishDir: string,
 *   repoRoot?: string,
 *   packageSources?: Record<string, string>,
 * }} options
 */
export function applyPiPatches(options) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const codingAgentSource = options.codingAgentSource;
  const tuiSource = options.tuiSource;
  const stageDir = options.stageDir;
  const publishDir = options.publishDir;
  if (!codingAgentSource || !tuiSource || !stageDir || !publishDir) {
    throw new ApplyPiPatchesError("codingAgentSource, tuiSource, stageDir, publishDir are required");
  }
  if (existsSync(publishDir)) {
    throw new ApplyPiPatchesError(`publish already exists: ${publishDir}`);
  }
  if (existsSync(stageDir)) {
    throw new ApplyPiPatchesError(`stage already exists: ${stageDir}`);
  }

  const sources = {
    ...options.packageSources,
    "pi-coding-agent": codingAgentSource,
    "pi-tui": tuiSource,
  };
  const manifest = loadManifest(repoRoot);
  const ids = new Set();
  for (const spec of manifest.packages) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.id) || ids.has(spec.id)) {
      throw new ApplyPiPatchesError(`invalid or duplicate package id: ${spec.id}`);
    }
    ids.add(spec.id);
    const id = spec.id;
    const source = sources[id] ?? join(codingAgentSource, "node_modules", "@earendil-works", id);
    sources[id] = source;
    if (!source) throw new ApplyPiPatchesError(`missing source for ${id}`);
    if (!existsSync(source)) throw new ApplyPiPatchesError(`missing source for ${id}: ${source}`);
    assertContained("stage", stageDir, source);
    assertContained("publish", publishDir, source);
    validatePackageSource(spec, source);
  }
  assertDistinct("stage", stageDir, "publish", publishDir);

  mkdirExclusive(stageDir, "stage");
  let ownedPublish = false;
  try {
    for (const spec of manifest.packages) {
      const sourceRoot = sources[spec.id];
      const stagePkg = join(stageDir, spec.id);
      stagePackage(spec, sourceRoot, stagePkg);
      for (const patch of spec.patches) {
        options.beforePatch?.({ packageId: spec.id, patchId: patch.id, stagePkg, publishDir });
        applyPatchFile(stagePkg, join(repoRoot, "harness", "pi-patches", patch.file));
      }
      verifyPostimage(spec, stagePkg);
    }
    mkdirExclusive(publishDir, "publish");
    ownedPublish = true;
    for (const spec of manifest.packages) {
      publishPackage(spec, join(stageDir, spec.id), join(publishDir, spec.id));
    }
  } catch (error) {
    if (ownedPublish) rmSync(publishDir, { recursive: true, force: true });
    throw error;
  }
  return {
    codingAgent: join(publishDir, "pi-coding-agent"),
    tui: join(publishDir, "pi-tui"),
  };
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || !process.argv[index + 1]) {
    throw new ApplyPiPatchesError(`missing ${flag}`);
  }
  return process.argv[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = applyPiPatches({
      codingAgentSource: readArg("--coding-agent"),
      tuiSource: readArg("--tui"),
      stageDir: readArg("--stage"),
      publishDir: readArg("--publish"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
