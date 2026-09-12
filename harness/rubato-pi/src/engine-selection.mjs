// Shared by launch, build, and status. No profile writes or dependency imports.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { nodeSatisfiesCandidate, selectNodeForEngine } from "./select-node.mjs";

export const STOCK_PI_FALLBACK_NOTICE = "rubato: stock-pi candidate is not installed or invalid; falling back to senpi";
export const STOCK_PI_NODE_FALLBACK_NOTICE = "rubato: no Node ^24.15 || >=26 available for stock-pi; falling back to senpi";

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
  if (explicit && explicit !== "senpi" && explicit !== "stock-pi") {
    warning = `rubato: unknown RUBATO_ENGINE=${explicit}; using default engine selection`;
    explicit = "";
  }
  const marker = readEngineMarker(env);
  let requested;
  let source;
  if (explicit === "senpi" || explicit === "stock-pi") {
    requested = explicit;
    source = "env";
  } else if (marker?.engine === "senpi" || marker?.engine === "stock-pi") {
    requested = marker.engine;
    source = "marker";
  } else if (valid) {
    requested = "stock-pi";
    source = "receipt";
  } else {
    requested = "senpi";
    source = "default";
  }
  const notice = (requested === "stock-pi" && !valid) || (present && !valid) ? STOCK_PI_FALLBACK_NOTICE : null;
  const engine = requested === "stock-pi" && valid ? "stock-pi" : "senpi";
  return {
    engine, requested, source, root, warning,
    fallback: engine !== requested || Boolean(notice),
    notice: engine === "stock-pi" ? null : notice,
    entry: engine === "stock-pi"
      ? (isAbsolute(receipt.candidateEntry) ? receipt.candidateEntry : join(root, receipt.candidateEntry))
      : null,
  };
}

export function resolveExecutionEngine({ env = process.env, selectNode = selectNodeForEngine } = {}) {
  const selection = resolveLaunchEngine({ env });
  const node = selectNode(selection.engine);
  if (selection.engine === "stock-pi" && (!node || !nodeSatisfiesCandidate(node.text))) {
    return { ...selection, engine: "senpi", entry: null, fallback: true, notice: STOCK_PI_NODE_FALLBACK_NOTICE, node };
  }
  return { ...selection, node };
}
