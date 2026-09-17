// Shared by launch, build, and status. No profile writes or dependency imports.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { nodeSatisfiesCandidate, selectNodeForEngine } from "./select-node.mjs";
import {
  ENGINE_ID, LEGACY_ENGINE_ID, RETIRED_ENGINE_ID,
  PI_ENGINE_DIRNAME, LEGACY_PI_ENGINE_DIRNAME,
  PI_ENGINE_DIR_ENV, LEGACY_PI_ENGINE_DIR_ENV,
  isLaunchableEngineId, firstEnv,
} from "./engine-id.mjs";

// Senpi fallback is retired (user decree 2026-09-13): rubato launches on
// pi or not at all. There is no fallback notice anymore; an unusable
// install is a hard error carrying its repair.
//
// The repair has to name a command that installs the candidate unconditionally.
// Two near misses: `rubato build` assembles the role system prompts
// (harness/prompts/build.sh) and never touches the engine, and `rubato update`
// returns early when the checkout is already current, so it cannot repair a
// missing install. `npm run build` goes straight to build-active-engine.mjs →
// updatePiEngine, which is what a broken install needs.
export const ENGINE_REPAIR_HINT = "run `npm run build` inside the rubato checkout";

function stateHome(env) {
  if (typeof env.HOME === "string" && env.HOME.trim() !== "") return env.HOME;
  try { return userInfo().homedir; } catch { return homedir(); }
}

export function defaultPiEngineDir(home) {
  return join(home, ".rubato-pi", PI_ENGINE_DIRNAME);
}

export function legacyPiEngineDir(home) {
  return join(home, ".rubato-pi", LEGACY_PI_ENGINE_DIRNAME);
}

export function piEngineDir(env = process.env) {
  const pinned = firstEnv(env, [PI_ENGINE_DIR_ENV, LEGACY_PI_ENGINE_DIR_ENV]);
  if (pinned) return pinned;
  const home = stateHome(env);
  const next = defaultPiEngineDir(home);
  const legacy = legacyPiEngineDir(home);
  if (piEngineReceiptPresent(legacy) && !piEngineReceiptPresent(next)) return legacy;
  return next;
}

/** @deprecated Use piEngineDir. Kept so existing call sites keep resolving. */
export const stockEngineDir = piEngineDir;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function readEngineMarker(env = process.env) {
  return readJson(join(stateHome(env), ".rubato-pi", "engine.json"));
}

export function readPiEngineReceipt(root) {
  return readJson(join(root, "rubato-install.json"));
}

export function piEngineReceiptPresent(root) {
  return Boolean(root) && existsSync(join(root, "rubato-install.json"));
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
  const root = piEngineDir(env);
  const present = piEngineReceiptPresent(root);
  const receipt = readPiEngineReceipt(root);
  const valid = isValidInstalledCandidateReceipt(receipt, root);
  let explicit = typeof env.RUBATO_ENGINE === "string" ? env.RUBATO_ENGINE.trim() : "";
  let warning = null;
  let error = null;
  const explicitRetired = explicit === RETIRED_ENGINE_ID;
  if (explicitRetired) {
    error = `rubato: the ${RETIRED_ENGINE_ID} engine is retired and can no longer run rubato; unset RUBATO_ENGINE to use ${ENGINE_ID}`;
    explicit = "";
  } else if (explicit && !isLaunchableEngineId(explicit)) {
    warning = `rubato: unknown RUBATO_ENGINE=${explicit}; using ${ENGINE_ID}`;
    explicit = "";
  }
  const marker = readEngineMarker(env);
  let requested;
  let source;
  requested = ENGINE_ID;
  if (isLaunchableEngineId(explicit) || explicitRetired) {
    source = "env";
  } else if (marker?.engine === RETIRED_ENGINE_ID || isLaunchableEngineId(marker?.engine)) {
    source = "marker";
  } else if (valid) {
    source = "receipt";
  } else {
    source = "default";
  }
  if (error === null && !valid) {
    error = present
      ? `rubato: pi engine at ${root} is not valid; ${ENGINE_REPAIR_HINT} to reinstall it`
      : `rubato: pi engine is not installed at ${root}; ${ENGINE_REPAIR_HINT} to install it`;
  }
  const engine = ENGINE_ID;
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
    return { ...selection, entry: null, error: selection.error ?? `rubato: no Node ^24.15 || >=26 available for ${ENGINE_ID} (${RETIRED_ENGINE_ID} fallback is retired)`, node };
  }
  return { ...selection, node };
}
