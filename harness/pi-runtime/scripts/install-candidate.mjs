import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRubatoCandidate } from "../build-candidate.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../features/rubato-components/candidate-main.mjs";
import { resolvePiRuntime } from "../resolve-runtime.mjs";
import { validateCandidateIsolation, validatePiInstall } from "../validate-install.mjs";

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

function requiredFeatures() {
  return [...CANDIDATE_FEATURE_NAMES, "rubato-components"];
}

async function writeInstallReceipt(outputRoot, receipt) {
  await writeFile(join(outputRoot, INSTALL_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
}

async function stageCandidate({ sourceRoot, npmRoot, outputRoot, bunExecutable, repoRoot }) {
  const staged = await buildRubatoCandidate({
    sourceRoot: npmRoot,
    outputRoot,
    repoRoot,
    bunExecutable,
  });
  const isolation = await validateCandidateIsolation(staged.runtime, { requiredFeatures: requiredFeatures() });
  const missing = requiredFeatures().filter((name) => !staged.receipt.features.includes(name));
  if (missing.length > 0) throw new Error(`Staged candidate is missing CANDIDATE_FEATURE_NAMES: ${missing.join(", ")}`);
  return { staged, isolation };
}

/**
 * Install the incomplete candidate into a fresh directory via npm ci + stage.
 * Never writes the default launcher, profile, or a live engine.
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
  if (mode !== "install" && mode !== "update") throw new Error(`Unknown install mode: ${mode}`);
  const exists = await pathExists(dest);
  let previous = null;
  if (mode === "install") {
    if (exists) throw new Error("Candidate install output already exists; choose a new directory or pass --update");
  } else {
    if (!exists) throw new Error("Candidate update requires an existing install directory");
    const priorReceipt = JSON.parse(await readFile(join(dest, INSTALL_RECEIPT), "utf8"));
    const snapshot = previousDir(dest);
    if (await pathExists(snapshot)) await retirePath(snapshot);
    await rename(dest, snapshot);
    previous = {
      dir: snapshot,
      installSha256: sha256(await readFile(join(snapshot, INSTALL_RECEIPT))),
      lockSha256: priorReceipt.hashes?.lock,
      stockVersion: priorReceipt.stockVersion,
      features: priorReceipt.features,
    };
  }

  const npmRoot = await mkdtemp(join(tmpdir(), "rubato-candidate-npmci-"));
  let retiredNpm;
  try {
    const ci = await npmCi({ sourceRoot: source, npmRoot, execPath });
    const { staged, isolation } = await stageCandidate({ sourceRoot: source, npmRoot, outputRoot: dest, bunExecutable, repoRoot });
    const stageBytes = await readFile(join(dest, "rubato-pi-stage.json"));
    const receipt = {
      version: 1,
      state: "ready",
      mode: "isolated-candidate",
      fullRubatoParity: false,
      stockVersion: staged.receipt.stockVersion,
      node: { version: process.version, execPath },
      features: staged.receipt.features,
      candidateEntry: "rubato-features/rubato-components/candidate-main.mjs",
      hashes: {
        package: staged.receipt.packageSha256,
        lock: staged.receipt.lockSha256,
        stageReceipt: sha256(stageBytes),
        npmLock: ci.lockSha256,
      },
      npmCi: {
        lockSha256: ci.lockSha256,
        directDependencies: ci.validated.directDependencies.map(({ name, version, integrity }) => ({ name, version, integrity })),
        stockPackages: ci.validated.packages.map(({ name, version, integrity }) => ({ name, version, integrity })),
      },
      senpiPty: isolation.senpiPty,
      previous,
      installedAt: new Date().toISOString(),
    };
    await writeInstallReceipt(dest, receipt);
    return { root: dest, receipt, staged, previous };
  } finally {
    retiredNpm = await retirePath(npmRoot).catch((error) => ({ method: "failed", path: npmRoot, error: error.message }));
  }
}

export async function updateRubatoCandidate(options) {
  return installRubatoCandidate({ ...options, mode: "update" });
}

export async function rollbackRubatoCandidate({ outputRoot } = {}) {
  const dest = requireAbsolute(outputRoot, "Candidate rollback");
  const snapshot = previousDir(dest);
  if (!await pathExists(snapshot)) throw new Error("Candidate rollback requires a previous snapshot next to the install");
  const discard = `${dest}.discard-${Date.now()}`;
  if (await pathExists(dest)) await rename(dest, discard);
  await rename(snapshot, dest);
  const receipt = JSON.parse(await readFile(join(dest, INSTALL_RECEIPT), "utf8"));
  return { root: dest, receipt, discarded: discard };
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
      root: result.root,
      node: result.receipt.node,
      stockVersion: result.receipt.stockVersion,
      features: result.receipt.features,
      hashes: result.receipt.hashes,
      candidateEntry: result.receipt.candidateEntry,
      previous: result.receipt.previous ?? null,
      discarded: result.discarded,
    }, null, 2)}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
