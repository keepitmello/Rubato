import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiRuntime } from "./resolve-runtime.mjs";
import { validatePiInstall } from "./validate-install.mjs";
import cmdShim from "cmd-shim";

const RECEIPT = "rubato-pi-stage.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function within(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function relativeTarget(packageDir, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new Error("Pi patch target must be a package-relative file");
  }
  const target = resolve(packageDir, path);
  if (!within(packageDir, target)) throw new Error(`Pi patch target escapes its package: ${path}`);
  return target;
}

async function validateLinks(modulesRoot, directory = modulesRoot) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !within(modulesRoot, await realpath(path))) {
        throw new Error(`Pi install symlink must stay relative and inside node_modules: ${path}`);
      }
    } else if (entry.isDirectory()) {
      await validateLinks(modulesRoot, path);
    }
  }
}

/**
 * Build selected capability hooks into a new, isolated installation.
 * Never changes a shared stock fixture, an existing output, or the live engine.
 * Hashes refer to pristine package files; independent features may then compose
 * in explicit order on the same file without rewriting each other's baselines.
 */
export async function stagePiRuntime({ sourceRoot, outputRoot, features = [] } = {}) {
  const source = resolvePiRuntime({ root: sourceRoot });
  const { packageJson, lock, packages: lockedPackages } = await validatePiInstall(source);
  if (typeof outputRoot !== "string" || outputRoot.trim() === "") {
    throw new Error("stagePiRuntime requires an explicit, new output directory");
  }
  const output = resolve(outputRoot);
  const outputParent = await realpath(dirname(output));
  const canonicalOutput = join(outputParent, relative(dirname(output), output));
  if (canonicalOutput === source.root || within(source.root, canonicalOutput) || within(canonicalOutput, source.root)) {
    throw new Error("Pi staging output must be separate from its source installation");
  }
  const ids = new Set();
  const patchIds = new Set();
  const changes = new Map();

  // Complete validation and transformations before claiming or writing output.
  for (const feature of features) {
    if (!feature || typeof feature.id !== "string" || !feature.id || ids.has(feature.id) || !Array.isArray(feature.patches)) {
      throw new Error("Pi features require unique ids and an explicit patches array");
    }
    ids.add(feature.id);
    for (const patch of feature.patches) {
      const patchId = `${feature.id}/${patch.id}`;
      if (typeof patch.id !== "string" || !patch.id || patchIds.has(patchId)) throw new Error(`Duplicate or missing Pi patch id: ${patchId}`);
      patchIds.add(patchId);
      const pkg = source.packages[patch.packageName];
      if (!pkg || pkg.version !== patch.version || typeof patch.apply !== "function") {
        throw new Error(`Pi patch ${patchId} does not match a selected stock package`);
      }
      const target = relativeTarget(pkg.dir, patch.path);
      if (!within(pkg.dir, await realpath(target))) throw new Error(`Pi patch target resolves outside its package: ${patchId}`);
      const original = await readFile(target);
      const before = sha256(original);
      if (before !== patch.preimageSha256) throw new Error(`Pi patch pristine hash mismatch: ${patchId}`);
      const prior = changes.get(target);
      const current = prior?.text ?? original.toString("utf8");
      const text = patch.apply(current);
      if (typeof text !== "string" || text === current) throw new Error(`Pi patch did not produce a change: ${patchId}`);
      changes.set(target, {
        packageName: pkg.name,
        path: relative(source.root, target),
        before,
        after: sha256(text),
        text,
        patches: [...(prior?.patches ?? []), patchId],
      });
    }
  }

  await validateLinks(join(source.root, "node_modules"));
  // Exclusive mkdir rejects existing files/directories, including racing stages.
  await mkdir(canonicalOutput);
  const receipt = {
    version: 1,
    state: "preparing",
    scope: "stock-pi-selected-features",
    fullRubatoParity: false,
    stockVersion: source.version,
    features: [...ids],
    entryMode: "unbundled",
    packageSha256: sha256(packageJson),
    lockSha256: sha256(lock),
    lockedPackages,
    files: [...changes.values()].map(({ text: _text, ...entry }) => entry),
  };
  const writeReceipt = () => writeFile(join(canonicalOutput, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
  await writeReceipt();
  try {
    await Promise.all([
      cp(join(source.root, "node_modules"), join(canonicalOutput, "node_modules"), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }),
      writeFile(join(canonicalOutput, "package.json"), packageJson),
      writeFile(join(canonicalOutput, "package-lock.json"), lock),
    ]);
    // Relative symlinks can change meaning when moved. Validate the copied graph
    // before any patch or shim writes, not just before marking the receipt ready.
    await validateLinks(join(canonicalOutput, "node_modules"));
    const runtime = resolvePiRuntime({ root: canonicalOutput });
    for (const change of changes.values()) {
      const stagedPath = join(canonicalOutput, change.path);
      const stagedPackage = runtime.packages[change.packageName];
      if (!within(stagedPackage.dir, await realpath(stagedPath))) {
        throw new Error(`Pi staged patch resolves outside its package: ${change.path}`);
      }
      if (sha256(await readFile(stagedPath)) !== change.before) throw new Error(`Stock input changed during staging: ${change.path}`);
      await writeFile(stagedPath, change.text);
      if (sha256(await readFile(stagedPath)) !== change.after) throw new Error(`Pi postimage mismatch: ${change.path}`);
    }
    await validatePiInstall(runtime);
    await validateLinks(join(canonicalOutput, "node_modules"));
    // The standard local binary must execute the same patched graph as the receipt.
    const binDir = join(canonicalOutput, "node_modules", ".bin");
    const binEntry = join(binDir, "pi");
    // npm's implementation handles POSIX, cmd.exe and PowerShell, including
    // spaces in paths, without requiring Windows symlink privileges.
    await cmdShim(runtime.patchableCliEntry, binEntry);
    receipt.binEntry = relative(canonicalOutput, binEntry);
    receipt.binShims = await Promise.all(["", ".cmd", ".ps1"].map(async (suffix) => ({
      path: relative(canonicalOutput, `${binEntry}${suffix}`),
      sha256: sha256(await readFile(`${binEntry}${suffix}`)),
    })));
    receipt.cliEntry = relative(canonicalOutput, runtime.patchableCliEntry);
    receipt.rpcEntry = relative(canonicalOutput, runtime.patchableRpcEntry);
    receipt.state = "ready";
    await writeReceipt();
    return { root: canonicalOutput, receipt, runtime };
  } catch (error) {
    receipt.state = "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
    await writeReceipt().catch(() => {});
    // Keep failed evidence; never recursively delete an output on the user's behalf.
    throw error;
  }
}

async function main(argv) {
  let sourceRoot;
  let outputRoot;
  const featureNames = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stock") sourceRoot = argv[++i];
    else if (arg === "--output") outputRoot = argv[++i];
    else if (arg === "--feature") featureNames.push(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const features = [];
  for (const name of featureNames) {
    if (name !== "reload") throw new Error(`Unknown Pi feature: ${name}`);
    const { patches } = await import("./features/reload/patches.mjs");
    features.push({ id: name, patches });
  }
  const result = await stagePiRuntime({ sourceRoot, outputRoot, features });
  process.stdout.write(`${JSON.stringify({ root: result.root, ...result.receipt }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
