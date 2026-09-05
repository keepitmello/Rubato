#!/usr/bin/env node
// Copy a complete stock Pi 0.84.2 install, apply owned patches, publish a
// self-contained package tree. Never writes the caller's source. Not a live
// engine switch.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPiPatches, ApplyPiPatchesError } from "./apply-pi-patches.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(here, "..", "..");
const CODING_AGENT_NAME = "@earendil-works/pi-coding-agent";
const TUI_NAME = "@earendil-works/pi-tui";
const TUI_NEST = join("node_modules", "@earendil-works", "pi-tui");
const STOCK_VERSION = "0.84.2";

export class StagePiEngineError extends Error {
  constructor(message) {
    super(message);
    this.name = "StagePiEngineError";
  }
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
      throw new StagePiEngineError(`${label} already exists: ${dir}`);
    }
    throw error;
  }
}

function assertDistinct(labelA, pathA, labelB, pathB) {
  const a = resolveIntended(pathA);
  const b = resolveIntended(pathB);
  if (a === b || isInside(a, b) || isInside(b, a)) {
    throw new StagePiEngineError(`${labelA} and ${labelB} overlap (${a} vs ${b})`);
  }
}

function assertNotInside(label, path, rootLabel, root) {
  if (!root) return;
  const real = existingRealpath(path);
  const rootReal = existingRealpath(root);
  if (isInside(real, rootReal)) {
    throw new StagePiEngineError(`${label} ${path} resolves inside ${rootLabel} (realpath ${real})`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isForbiddenPackageName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.startsWith("@code-yeongyu/")) return true;
  return /senpi/i.test(name);
}

function walkEntries(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new StagePiEngineError(`cannot read ${dir}: ${error instanceof Error ? error.message : error}`);
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const kind = entry.isSymbolicLink()
        ? "link"
        : entry.isDirectory()
          ? "dir"
          : "file";
      visit(abs, kind, entry.name);
      if (kind === "dir") stack.push(abs);
    }
  }
}

function assertNoSenpi(root) {
  walkEntries(root, (abs, kind, name) => {
    if (kind === "dir" && (name === "@code-yeongyu" || /senpi/i.test(name))) {
      throw new StagePiEngineError(`Senpi package path in dependency graph: ${abs}`);
    }
    if (kind !== "file" || name !== "package.json") return;
    let pkg;
    try {
      pkg = readJson(abs);
    } catch (error) {
      throw new StagePiEngineError(`invalid package.json at ${abs}: ${error instanceof Error ? error.message : error}`);
    }
    if (isForbiddenPackageName(pkg.name)) {
      throw new StagePiEngineError(`Senpi package in dependency graph: ${pkg.name} at ${abs}`);
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = pkg[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [depName, depSpec] of Object.entries(deps)) {
        if (isForbiddenPackageName(depName) || isForbiddenPackageName(String(depSpec))) {
          throw new StagePiEngineError(`Senpi dependency ${depName} at ${abs}`);
        }
      }
    }
  });
}

function assertNoEscapingLinks(root) {
  const rootReal = existingRealpath(root);
  walkEntries(root, (abs, kind) => {
    if (kind !== "link") return;
    const target = readlinkSync(abs);
    if (isAbsolute(target)) {
      throw new StagePiEngineError(`absolute symlink backref ${abs} -> ${target}`);
    }
    const lexical = normalize(join(dirname(abs), target));
    if (!isInside(lexical, root) && !isInside(existingRealpath(lexical), rootReal)) {
      throw new StagePiEngineError(`symlink escapes tree ${abs} -> ${target}`);
    }
    try {
      const real = realpathSync(abs);
      if (!isInside(real, rootReal)) {
        throw new StagePiEngineError(`symlink realpath escapes tree ${abs} -> ${real}`);
      }
    } catch (error) {
      if (error instanceof StagePiEngineError) throw error;
      // Dangling relative link: lexical containment already checked.
    }
  });
}

function readPackageIdentity(packageRoot) {
  const pkgPath = join(packageRoot, "package.json");
  if (!existsSync(pkgPath)) {
    throw new StagePiEngineError(`missing package.json under ${packageRoot}`);
  }
  return readJson(pkgPath);
}

export function resolveStockPiPackages(stock) {
  if (!stock || !existsSync(stock)) {
    throw new StagePiEngineError(`missing stock install/source: ${stock}`);
  }
  const direct = join(stock, "package.json");
  if (existsSync(direct)) {
    const pkg = readJson(direct);
    if (pkg.name === CODING_AGENT_NAME) {
      return {
        codingAgent: stock,
        tui: join(stock, TUI_NEST),
      };
    }
  }
  const nested = join(stock, "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(join(nested, "package.json"))) {
    return {
      codingAgent: nested,
      tui: join(nested, TUI_NEST),
    };
  }
  throw new StagePiEngineError(
    `stock ${stock} is not ${CODING_AGENT_NAME}@${STOCK_VERSION} or an install containing it`,
  );
}

function assertStockIdentity(sources) {
  const coding = readPackageIdentity(sources.codingAgent);
  if (coding.name !== CODING_AGENT_NAME || coding.version !== STOCK_VERSION) {
    throw new StagePiEngineError(
      `package identity mismatch at ${sources.codingAgent}: ${coding.name}@${coding.version} != ${CODING_AGENT_NAME}@${STOCK_VERSION}`,
    );
  }
  if (!existsSync(sources.tui)) {
    throw new StagePiEngineError(`missing nested ${TUI_NAME} at ${sources.tui}`);
  }
  const tui = readPackageIdentity(sources.tui);
  if (tui.name !== TUI_NAME || tui.version !== STOCK_VERSION) {
    throw new StagePiEngineError(
      `package identity mismatch at ${sources.tui}: ${tui.name}@${tui.version} != ${TUI_NAME}@${STOCK_VERSION}`,
    );
  }
}

function loadManifest(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, "harness", "pi-patches", "manifest.json"), "utf8"));
}

function writeFileBytes(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    throw new StagePiEngineError(`refusing to write through symlink ${dest}`);
  }
  writeFileSync(dest, buf);
}

function overlayPublished(publishDir, destCodingAgent, destTui, repoRoot) {
  const manifest = loadManifest(repoRoot);
  for (const spec of manifest.packages) {
    const from = join(publishDir, spec.id);
    const to = spec.id === "pi-coding-agent" ? destCodingAgent
      : spec.id === "pi-tui" ? destTui
      : join(destCodingAgent, "node_modules", "@earendil-works", spec.id);
    for (const file of spec.files) {
      const src = join(from, file.path);
      if (!existsSync(src)) {
        throw new StagePiEngineError(`patched file missing ${spec.id}:${file.path}`);
      }
      writeFileBytes(join(to, file.path), readFileSync(src));
    }
  }
}

/**
 * @param {{
 *   stock: string,
 *   output: string,
 *   repoRoot?: string,
 * }} options
 */
export function stagePiEngine(options) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const stock = options.stock;
  const output = options.output;
  if (!stock || !output) {
    throw new StagePiEngineError("stock and output are required");
  }
  if (existsSync(output)) {
    throw new StagePiEngineError(`output already exists: ${output}`);
  }

  const sources = resolveStockPiPackages(stock);
  assertStockIdentity(sources);
  assertDistinct("stock", sources.codingAgent, "output", output);
  assertDistinct("tui", sources.tui, "output", output);
  assertNotInside("output", output, "stock", sources.codingAgent);
  assertNotInside("output", output, "tui", sources.tui);
  assertNotInside("output", output, "stock-root", stock);
  assertNoSenpi(sources.codingAgent);
  assertNoEscapingLinks(sources.codingAgent);

  const dependencies = (loadManifest(repoRoot).additionalDependencies ?? []).map((spec) => {
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(spec.name)) {
      throw new StagePiEngineError(`invalid additional dependency name: ${spec.name}`);
    }
    const source = realpathSync(join(repoRoot, "node_modules", spec.name));
    const pkg = readPackageIdentity(source);
    if (pkg.name !== spec.name || pkg.version !== spec.version) {
      throw new StagePiEngineError(`additional dependency identity mismatch: ${spec.name}@${spec.version}`);
    }
    if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length ||
        Object.keys(pkg.peerDependencies ?? {}).length) {
      throw new StagePiEngineError(`additional dependency needs an explicit dependency closure: ${spec.name}`);
    }
    assertDistinct("dependency", source, "output", output);
    assertNoSenpi(source);
    assertNoEscapingLinks(source);
    return { ...spec, source };
  });

  const work = mkdtempSync(join(tmpdir(), "pi-engine-stage-"));
  const patchStage = join(work, "patch-stage");
  const patchPublish = join(work, "patch-publish");
  let ownedOutput = false;
  try {
    applyPiPatches({
      codingAgentSource: sources.codingAgent,
      tuiSource: sources.tui,
      packageSources: Object.fromEntries(loadManifest(repoRoot).packages.map((spec) => [
        spec.id,
        spec.id === "pi-coding-agent" ? sources.codingAgent
          : join(sources.codingAgent, "node_modules", "@earendil-works", spec.id),
      ])),
      stageDir: patchStage,
      publishDir: patchPublish,
      repoRoot,
    });
    mkdirExclusive(output, "output");
    ownedOutput = true;
    cpSync(sources.codingAgent, output, { recursive: true, verbatimSymlinks: true });
    overlayPublished(patchPublish, output, join(output, TUI_NEST), repoRoot);
    for (const dependency of dependencies) {
      const destination = join(output, "node_modules", dependency.name);
      if (existsSync(destination)) {
        throw new StagePiEngineError(`additional dependency already exists in stock tree: ${dependency.name}`);
      }
      cpSync(dependency.source, destination, { recursive: true, verbatimSymlinks: true });
    }
    assertNoSenpi(output);
    assertNoEscapingLinks(output);
  } catch (error) {
    if (ownedOutput) rmSync(output, { recursive: true, force: true });
    if (error instanceof StagePiEngineError || error instanceof ApplyPiPatchesError) throw error;
    throw new StagePiEngineError(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return {
    codingAgent: output,
    tui: join(output, TUI_NEST),
  };
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || !process.argv[index + 1]) {
    throw new StagePiEngineError(`missing ${flag}`);
  }
  return process.argv[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = stagePiEngine({
      stock: readArg("--stock"),
      output: readArg("--output"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
