// Switch the product default engine between the installed stock-Pi candidate
// and Senpi. Never writes the live profile; HOME (or {home}) chooses the
// state dir. After switch, sessions are written by stock-pi. RUBATO_ENGINE=senpi
// on the same profile is rollback-only (double-writer rule).
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installRubatoCandidate } from "./install-candidate.mjs";

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

export function isValidInstalledCandidateReceipt(receipt, root) {
  if (!receipt || receipt.version !== 1 || receipt.state !== "ready") return false;
  if (typeof receipt.candidateEntry !== "string" || receipt.candidateEntry.length === 0) return false;
  if (!Array.isArray(receipt.features) || receipt.features.length === 0) return false;
  if (!root) return true;
  const entry = isAbsolute(receipt.candidateEntry) ? receipt.candidateEntry : join(root, receipt.candidateEntry);
  return existsSync(entry);
}

export async function readInstallReceipt(root) {
  try {
    return JSON.parse(await readFile(join(root, "rubato-install.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function readEngineMarker(home) {
  try {
    return JSON.parse(await readFile(engineMarkerPath(home), "utf8"));
  } catch {
    return null;
  }
}

async function writeEngineMarker(home, marker) {
  const path = engineMarkerPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export async function installStockEngine({
  home,
  outputRoot,
  env = process.env,
  install = installRubatoCandidate,
} = {}) {
  const resolvedHome = resolveSwitchHome({ home, env });
  const dest = outputRoot ?? stockEngineDir(resolvedHome);
  const receipt = await readInstallReceipt(dest);
  if (isValidInstalledCandidateReceipt(receipt, dest)) {
    return { root: dest, receipt, skipped: true };
  }
  if (existsSync(dest)) {
    throw new Error(`stock-engine exists but is not a valid candidate install: ${dest}`);
  }
  return { skipped: false, ...(await install({ outputRoot: dest })) };
}

export async function switchEngine({
  home,
  engine = "stock-pi",
  env = process.env,
  installIfMissing = false,
  install = installRubatoCandidate,
} = {}) {
  if (engine !== "stock-pi" && engine !== "senpi") throw new Error(`Unknown engine: ${engine}`);
  const resolvedHome = resolveSwitchHome({ home, env });
  const dest = stockEngineDir(resolvedHome);
  if (engine === "stock-pi") {
    const receipt = await readInstallReceipt(dest);
    if (!isValidInstalledCandidateReceipt(receipt, dest)) {
      if (!installIfMissing) throw new Error("stock-pi is not installed; run install first");
      await installStockEngine({ home: resolvedHome, install, env });
    }
  }
  const current = await readEngineMarker(resolvedHome);
  const previous = current?.engine === "senpi" || current?.engine === "stock-pi"
    ? current.engine
    : "senpi";
  const marker = {
    engine,
    installedAt: current?.installedAt ?? new Date().toISOString(),
    switchedAt: new Date().toISOString(),
    previous: previous === engine ? (current?.previous ?? (engine === "stock-pi" ? "senpi" : "stock-pi")) : previous,
    installRoot: dest,
  };
  await writeEngineMarker(resolvedHome, marker);
  return marker;
}

export async function rollbackEngine({ home, env = process.env } = {}) {
  const resolvedHome = resolveSwitchHome({ home, env });
  const current = await readEngineMarker(resolvedHome);
  if (!current) throw new Error("No engine marker to roll back");
  const previous = current.previous === "stock-pi" || current.previous === "senpi" ? current.previous : "senpi";
  const marker = {
    engine: previous,
    installedAt: current.installedAt,
    switchedAt: new Date().toISOString(),
    previous: current.engine,
    installRoot: current.installRoot ?? stockEngineDir(resolvedHome),
    rolledBackAt: new Date().toISOString(),
  };
  await writeEngineMarker(resolvedHome, marker);
  return marker;
}

export async function engineStatus({ home, env = process.env } = {}) {
  const resolvedHome = resolveSwitchHome({ home, env });
  const dest = stockEngineDir(resolvedHome);
  const receipt = await readInstallReceipt(dest);
  const marker = await readEngineMarker(resolvedHome);
  const valid = isValidInstalledCandidateReceipt(receipt, dest);
  return {
    home: resolvedHome,
    installRoot: dest,
    installed: valid,
    marker,
    engine: marker?.engine ?? (valid ? "stock-pi" : "senpi"),
    receipt: receipt ? {
      version: receipt.version,
      state: receipt.state,
      stockVersion: receipt.stockVersion,
      candidateEntry: receipt.candidateEntry,
      installedAt: receipt.installedAt,
      featureCount: Array.isArray(receipt.features) ? receipt.features.length : 0,
    } : null,
  };
}

function parseArgs(argv) {
  let command;
  const rest = [];
  for (const arg of argv) {
    if (!command && ["install", "switch", "rollback", "status"].includes(arg)) command = arg;
    else rest.push(arg);
  }
  if (!command) throw new Error("Usage: node scripts/switch-engine.mjs install|switch|rollback|status");
  return { command, rest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command } = parseArgs(process.argv.slice(2));
  const home = process.env.HOME;
  const run = command === "install" ? installStockEngine({ home })
    : command === "switch" ? switchEngine({ home, installIfMissing: true })
    : command === "rollback" ? rollbackEngine({ home })
    : engineStatus({ home });
  run.then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

