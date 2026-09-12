// Select/update the product engine without modifying auth or session data.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installRubatoCandidate } from "./install-candidate.mjs";
import {
  isValidInstalledCandidateReceipt, resolveExecutionEngine, stockEngineDir as selectedStockDir,
} from "../../rubato-pi/src/engine-selection.mjs";
export { isValidInstalledCandidateReceipt } from "../../rubato-pi/src/engine-selection.mjs";

export function stockEngineDir(home) {
  return join(home, ".rubato-pi", "stock-engine");
}

export function engineMarkerPath(home) {
  return join(home, ".rubato-pi", "engine.json");
}

export function resolveSwitchHome({ home, env = process.env } = {}) {
  if (typeof home === "string" && home.trim() !== "") return home;
  if (typeof env.HOME === "string" && env.HOME.trim() !== "") return env.HOME;
  return homedir();
}

function installRoot(home, env) {
  return selectedStockDir({ ...env, HOME: home });
}

export async function readInstallReceipt(root) {
  try { return JSON.parse(await readFile(join(root, "rubato-install.json"), "utf8")); }
  catch { return null; }
}

export async function readEngineMarker(home) {
  try { return JSON.parse(await readFile(engineMarkerPath(home), "utf8")); }
  catch { return null; }
}

async function writeEngineMarker(home, marker) {
  const path = engineMarkerPath(home);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return marker;
}

export async function installStockEngine({ home, outputRoot, env = process.env, install = installRubatoCandidate } = {}) {
  const resolvedHome = resolveSwitchHome({ home, env });
  const dest = outputRoot ?? installRoot(resolvedHome, env);
  const receipt = await readInstallReceipt(dest);
  if (isValidInstalledCandidateReceipt(receipt, dest)) return { root: dest, receipt, skipped: true };
  if (existsSync(dest)) throw new Error(`stock-engine exists but is not a valid candidate install: ${dest}`);
  return { skipped: false, ...(await install({ outputRoot: dest })) };
}

/** Explicit refresh; unlike switch/install, an existing ready install is rebuilt. */
export async function updateStockEngine({ home, env = process.env, install = installRubatoCandidate } = {}) {
  const resolvedHome = resolveSwitchHome({ home, env });
  const dest = installRoot(resolvedHome, env);
  const receipt = await readInstallReceipt(dest);
  if (existsSync(dest) && !isValidInstalledCandidateReceipt(receipt, dest)) {
    throw new Error(`stock-engine exists but is not a valid candidate install: ${dest}`);
  }
  return install({ outputRoot: dest, mode: existsSync(dest) ? "update" : "install" });
}

export async function switchEngine({ home, engine = "stock-pi", env = process.env,
  installIfMissing = false, install = installRubatoCandidate } = {}) {
  if (engine !== "stock-pi" && engine !== "senpi") throw new Error(`Unknown engine: ${engine}`);
  const resolvedHome = resolveSwitchHome({ home, env });
  const dest = installRoot(resolvedHome, env);
  if (engine === "stock-pi") {
    const receipt = await readInstallReceipt(dest);
    if (!isValidInstalledCandidateReceipt(receipt, dest)) {
      if (!installIfMissing) throw new Error("stock-pi is not installed; run install first");
      await installStockEngine({ home: resolvedHome, install, env });
    }
  }
  const current = await readEngineMarker(resolvedHome);
  // Senpi rollback is retired, so a marker must never record senpi as the
  // rollback target: writing `previous: "senpi"` here would manufacture a
  // marker that rollbackEngine can only refuse. stock-pi is the only engine
  // there is, so it is the only previous there can be.
  const marker = {
    engine,
    installedAt: current?.installedAt ?? new Date().toISOString(),
    switchedAt: new Date().toISOString(),
    previous: "stock-pi",
    installRoot: dest,
  };
  await writeEngineMarker(resolvedHome, marker);
  return marker;
}

export async function rollbackEngine({ home, env = process.env } = {}) {
  const resolvedHome = resolveSwitchHome({ home, env });
  const current = await readEngineMarker(resolvedHome);
  if (!current) throw new Error("No engine marker to roll back");
  // Senpi rollback is retired (user decree 2026-09-13): there is no senpi engine
  // to go back to. switchEngine no longer writes this, but markers written
  // before the retirement still carry it.
  if (current.previous === "senpi") throw new Error("rubato: cannot roll back to the retired senpi engine; run `rubato update` to reinstall stock-pi");
  const previous = current.previous === "stock-pi" ? current.previous : "stock-pi";
  const marker = {
    engine: previous, installedAt: current.installedAt, switchedAt: new Date().toISOString(),
    previous: current.engine, installRoot: current.installRoot ?? installRoot(resolvedHome, env),
    rolledBackAt: new Date().toISOString(),
  };
  await writeEngineMarker(resolvedHome, marker);
  return marker;
}

export async function engineStatus({ home, env = process.env, selectNode } = {}) {
  const resolvedHome = resolveSwitchHome({ home, env });
  const selection = resolveExecutionEngine({ env: { ...env, HOME: resolvedHome }, selectNode });
  const dest = selection.root;
  const receipt = await readInstallReceipt(dest);
  const marker = await readEngineMarker(resolvedHome);
  return {
    home: resolvedHome, installRoot: dest,
    installed: isValidInstalledCandidateReceipt(receipt, dest), marker,
    engine: selection.engine, requested: selection.requested, source: selection.source,
    fallback: selection.fallback, notice: selection.notice, warning: selection.warning,
    error: selection.error ?? null,
    nodeAvailable: Boolean(selection.node), node: selection.node,
    receipt: receipt ? {
      version: receipt.version, state: receipt.state, stockVersion: receipt.stockVersion,
      candidateEntry: receipt.candidateEntry, installedAt: receipt.installedAt,
      featureCount: Array.isArray(receipt.features) ? receipt.features.length : 0,
      sourceSha256: receipt.sourceSha256 ?? null,
    } : null,
  };
}

function parseArgs(argv) {
  if (argv.length !== 1 || !["install", "update", "switch", "rollback", "status"].includes(argv[0])) {
    throw new Error("Usage: node scripts/switch-engine.mjs install|update|switch|rollback|status");
  }
  return argv[0];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const command = parseArgs(process.argv.slice(2));
    const home = process.env.HOME;
    return command === "install" ? installStockEngine({ home })
      : command === "update" ? updateStockEngine({ home })
      : command === "switch" ? switchEngine({ home, installIfMissing: true })
      : command === "rollback" ? rollbackEngine({ home })
      : engineStatus({ home });
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
