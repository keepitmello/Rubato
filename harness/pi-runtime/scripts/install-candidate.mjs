import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stageAndPublishInstall, withInstallLock } from "./install-transaction.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const defaultSourceRoot = resolve(here, "..");
const INSTALL_RECEIPT = "rubato-install.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function requireNodeEngine() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 24 && minor >= 15) || major >= 26)) {
    throw new Error(`Candidate install requires Node ^24.15 || >=26, got ${process.version}`);
  }
}

function requireAbsolute(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} requires an absolute path`);
  return resolve(path);
}

function npmCli(execPath = process.execPath) {
  return join(dirname(execPath), process.platform === "win32" ? "npm.cmd" : "npm");
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  delete env.NODE_COMPILE_CACHE;
  return env;
}

/** Prefer a trash move when recursive delete is blocked by a local wrapper. */
export async function retirePath(path, { trashRoot } = {}) {
  try {
    await rm(path, { recursive: true, force: true });
    return { method: "rm", path };
  } catch (error) {
    const trash = trashRoot ?? await mkdtemp(join(tmpdir(), "rubato-isolated-trash-"));
    const dest = join(trash, `${Date.now()}-${basename(path)}`);
    await rename(path, dest);
    return { method: "trash", path, trash: dest, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pathExists(path) {
  return lstat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

function previousDir(outputRoot) {
  return `${outputRoot}.previous`;
}

async function npmCi({ sourceRoot, npmRoot, execPath = process.execPath }) {
  // Status/build-check can load this module before standalone dependencies exist.
  const { resolvePiRuntime } = await import("../resolve-runtime.mjs");
  const { validatePiInstall } = await import("../validate-install.mjs");
  await copyFile(join(sourceRoot, "package.json"), join(npmRoot, "package.json"));
  await copyFile(join(sourceRoot, "package-lock.json"), join(npmRoot, "package-lock.json"));
  const lockBefore = sha256(await readFile(join(npmRoot, "package-lock.json")));
  const result = await run(npmCli(execPath), ["ci", "--workspaces=false", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: npmRoot,
    env: cleanEnv(),
    timeout: 300_000,
    maxBuffer: 12 * 1024 * 1024,
  });
  const lockAfter = sha256(await readFile(join(npmRoot, "package-lock.json")));
  if (lockBefore !== lockAfter) throw new Error("npm ci mutated the pinned lock");
  const runtime = resolvePiRuntime({ root: npmRoot });
  const validated = await validatePiInstall(runtime);
  return {
    runtime,
    validated,
    lockSha256: lockAfter,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function requiredFeatures() {
  const { CANDIDATE_FEATURE_NAMES } = await import("../features/rubato-components/candidate-main.mjs");
  return [...CANDIDATE_FEATURE_NAMES, "rubato-components"];
}

async function writeInstallReceipt(outputRoot, receipt) {
  await writeFile(join(outputRoot, INSTALL_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
}

async function stageCandidate({ sourceRoot, npmRoot, outputRoot, bunExecutable, repoRoot }) {
  const { buildRubatoCandidate } = await import("../build-candidate.mjs");
  const { validateCandidateIsolation } = await import("../validate-install.mjs");
  const staged = await buildRubatoCandidate({
    sourceRoot: npmRoot,
    outputRoot,
    repoRoot,
    bunExecutable,
  });
  const required = await requiredFeatures();
  const isolation = await validateCandidateIsolation(staged.runtime, { requiredFeatures: required });
  const missing = required.filter((name) => !staged.receipt.features.includes(name));
  if (missing.length > 0) throw new Error(`Staged candidate is missing CANDIDATE_FEATURE_NAMES: ${missing.join(", ")}`);
  return { staged, isolation };
}

/** Build a fresh candidate first; publish it only after validation succeeds.
 * Does not switch the launcher marker or touch auth/session files.
 */
export async function installRubatoCandidate({
  outputRoot,
  sourceRoot = defaultSourceRoot,
  repoRoot,
  bunExecutable,
  execPath = process.execPath,
  mode = "install",
} = {}) {
  requireNodeEngine();
  const dest = requireAbsolute(outputRoot, "Candidate install");
  const source = requireAbsolute(sourceRoot, "Candidate source");
  const repo = requireAbsolute(repoRoot ?? resolve(defaultSourceRoot, "../.."), "Candidate repository");
  const result = await stageAndPublishInstall(dest, {
    mode,
    retire: retirePath,
    async build(stagingRoot, currentRoot) {
      let previous = null;
      if (currentRoot) {
        const priorBytes = await readFile(join(currentRoot, INSTALL_RECEIPT));
        const prior = JSON.parse(priorBytes);
        previous = {
          dir: previousDir(dest), installSha256: sha256(priorBytes),
          lockSha256: prior.hashes?.lock, stockVersion: prior.stockVersion, features: prior.features,
        };
      }
      const sourceSha256 = await sourceFingerprint(repo);
      const npmRoot = await mkdtemp(join(tmpdir(), "rubato-candidate-npmci-"));
      try {
        const ci = await npmCi({ sourceRoot: source, npmRoot, execPath });
        const { staged, isolation } = await stageCandidate({ sourceRoot: source, npmRoot, outputRoot: stagingRoot, bunExecutable, repoRoot: repo });
        const stageBytes = await readFile(join(stagingRoot, "rubato-pi-stage.json"));
        if (await sourceFingerprint(repo) !== sourceSha256) throw new Error("Candidate sources changed during build; current install was not replaced");
        const receipt = {
          version: 1, state: "ready", mode: "isolated-candidate", fullRubatoParity: false,
          stockVersion: staged.receipt.stockVersion,
          node: { version: process.version, execPath },
          features: staged.receipt.features,
          candidateEntry: "rubato-features/rubato-components/candidate-main.mjs",
          sourceSha256,
          hashes: {
            package: staged.receipt.packageSha256, lock: staged.receipt.lockSha256,
            stageReceipt: sha256(stageBytes), npmLock: ci.lockSha256,
          },
          npmCi: {
            lockSha256: ci.lockSha256,
            directDependencies: ci.validated.directDependencies.map(({ name, version, integrity }) => ({ name, version, integrity })),
            stockPackages: ci.validated.packages.map(({ name, version, integrity }) => ({ name, version, integrity })),
          },
          senpiPty: isolation.senpiPty, previous, installedAt: new Date().toISOString(),
        };
        await writeInstallReceipt(stagingRoot, receipt);
        return { root: dest, receipt, staged, previous };
      } finally {
        await retirePath(npmRoot);
      }
    },
  });
  // stagePiRuntime's return value contains absolute paths. Rebind those public
  // paths after the relocatable installation has been renamed into place.
  const { resolvePiRuntime } = await import("../resolve-runtime.mjs");
  return { ...result, staged: { ...result.staged, root: dest,
    runtime: resolvePiRuntime({ root: dest }), candidateEntry: join(dest, result.receipt.candidateEntry) } };
}

export async function updateRubatoCandidate(options) {
  return installRubatoCandidate({ ...options, mode: "update" });
}

export async function rollbackRubatoCandidate({ outputRoot } = {}) {
  const dest = requireAbsolute(outputRoot, "Candidate rollback");
  return withInstallLock(dest, async () => {
    const snapshot = previousDir(dest);
    if (!await pathExists(snapshot)) throw new Error("Candidate rollback requires a previous snapshot next to the install");
    // Validate before moving the currently working directory out of the way.
    const receipt = JSON.parse(await readFile(join(snapshot, INSTALL_RECEIPT), "utf8"));
    if (receipt.state !== "ready") throw new Error("Previous candidate is not ready");
    const discard = `${dest}.discard-${Date.now()}`;
    const present = await pathExists(dest);
    if (present) await rename(dest, discard);
    try {
      await rename(snapshot, dest);
    } catch (error) {
      if (present) await rename(discard, dest);
      throw error;
    }
    return { root: dest, receipt, discarded: present ? discard : null };
  });
}

export async function chmodSenpiTraps(trapRoot) {
  const names = ["senpi", "senpi-ai", "senpi-codemode", "senpi-tui"];
  const created = [];
  for (const name of names) {
    const dir = join(trapRoot, "node_modules", "@code-yeongyu", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: `@code-yeongyu/${name}`, version: "0.0.0-unreadable-trap", type: "module", exports: { ".": "./index.js" } })}\n`);
    await writeFile(join(dir, "index.js"), "throw new Error(\"Senpi app package must not load from an isolated candidate\");\n");
    await chmod(dir, 0o000);
    created.push(dir);
  }
  return created;
}

export async function chmodRestoreTraps(dirs) {
  for (const dir of dirs ?? []) {
    await chmod(dir, 0o755).catch(() => {});
  }
}

function parseArgs(argv) {
  let outputRoot;
  let sourceRoot;
  let mode = "install";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") outputRoot = argv[++i];
    else if (arg === "--source") sourceRoot = argv[++i];
    else if (arg === "--update") mode = "update";
    else if (arg === "--rollback") mode = "rollback";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!outputRoot) throw new Error("Usage: node scripts/install-candidate.mjs --output /absolute/dir [--update|--rollback]");
  return { outputRoot, sourceRoot, mode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outputRoot, sourceRoot, mode } = parseArgs(process.argv.slice(2));
  const runInstall = mode === "rollback"
    ? rollbackRubatoCandidate({ outputRoot })
    : installRubatoCandidate({ outputRoot, sourceRoot, mode });
  runInstall.then((result) => {
    process.stdout.write(`${JSON.stringify({
      root: result.root, node: result.receipt.node, stockVersion: result.receipt.stockVersion,
      features: result.receipt.features, hashes: result.receipt.hashes,
      candidateEntry: result.receipt.candidateEntry, previous: result.receipt.previous ?? null,
      discarded: result.discarded,
    }, null, 2)}\n`);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
