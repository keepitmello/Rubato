// Shared by launch, build, and status. No profile writes or dependency imports.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { nodeSatisfiesCandidate, selectNodeForEngine } from "./select-node.mjs";

// Senpi fallback is retired (user decree 2026-09-13): rubato launches on
// stock-pi or not at all. There is no fallback notice anymore; an unusable
// install is a hard error carrying its repair.

function stateHome(env) {
  if (typeof env.HOME === "string" && env.HOME.trim() !== "") return env.HOME;
  try { return userInfo().homedir; } catch { return homedir(); }
}

export function stockEngineDir(env = process.env) {
  const pinned = env.RUBATO_STOCK_ENGINE_DIR;
  if (typeof pinned === "string" && pinned.trim() !== "") return pinned;
  return join(stateHome(env), ".rubato-pi", "stock-engine");
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function readEngineMarker(env = process.env) {
  return readJson(join(stateHome(env), ".rubato-pi", "engine.json"));
}

export function readStockEngineReceipt(root) {
  return readJson(join(root, "rubato-install.json"));
}

export function stockEngineReceiptPresent(root) {
  return existsSync(join(root, "rubato-install.json"));
}

export function isValidInstalledCandidateReceipt(receipt, root) {
  if (!receipt || receipt.version !== 1 || receipt.state !== "ready") return false;
  if (typeof receipt.candidateEntry !== "string" || receipt.candidateEntry.length === 0) return false;
  if (!Array.isArray(receipt.features) || receipt.features.length === 0) return false;
  if (!root) return true;
  const entry = isAbsolute(receipt.candidateEntry) ? receipt.candidateEntry : join(root, receipt.candidateEntry);
  try { return statSync(entry).isFile(); } catch { return false; }
}

export function resolveLaunchEngine({ env = process.env } = {}) {
  const root = stockEngineDir(env);
  const present = stockEngineReceiptPresent(root);
  const receipt = readStockEngineReceipt(root);
  const valid = isValidInstalledCandidateReceipt(receipt, root);
  let explicit = typeof env.RUBATO_ENGINE === "string" ? env.RUBATO_ENGINE.trim() : "";
  let warning = null;
  let error = null;
  const explicitSenpi = explicit === "senpi";
  if (explicitSenpi) {
    error = "rubato: the senpi engine is retired and can no longer run rubato; unset RUBATO_ENGINE to use stock-pi";
    explicit = "";
  } else if (explicit && explicit !== "stock-pi") {
    warning = `rubato: unknown RUBATO_ENGINE=${explicit}; using stock-pi`;
    explicit = "";
  }
  const marker = readEngineMarker(env);
  let requested;
  let source;
  // The only launchable engine is stock-pi. requested/source still record where
  // the request came from for status and diagnostics.
  requested = "stock-pi";
  if (explicit === "stock-pi" || explicitSenpi) {
    source = "env";
  } else if (marker?.engine === "senpi" || marker?.engine === "stock-pi") {
    source = "marker";
  } else if (valid) {
    source = "receipt";
  } else {
    source = "default";
  }
  if (error === null && !valid) {
    error = present
      ? `rubato: stock-pi engine at ${root} is not valid; run \`rubato build\` to reinstall it (senpi fallback is retired)`
      : `rubato: stock-pi engine is not installed at ${root}; run \`rubato build\` to install it (senpi fallback is retired)`;
  }
  const engine = "stock-pi";
  return {
    engine, requested, source, root, warning, error,
    fallback: false,
    notice: null,
    entry: valid
      ? (isAbsolute(receipt.candidateEntry) ? receipt.candidateEntry : join(root, receipt.candidateEntry))
      : null,
  };
}

export function resolveExecutionEngine({ env = process.env, selectNode = selectNodeForEngine } = {}) {
  const selection = resolveLaunchEngine({ env });
  const node = selectNode(selection.engine);
  if (!node || !nodeSatisfiesCandidate(node.text)) {
    return { ...selection, entry: null, error: selection.error ?? "rubato: no Node ^24.15 || >=26 available for stock-pi (senpi fallback is retired)", node };
  }
  return { ...selection, node };
}
