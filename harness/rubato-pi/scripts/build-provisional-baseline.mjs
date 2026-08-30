#!/usr/bin/env node
/**
 * Offline generator for the bundled provisional baseline v0.
 *
 * Reads local agent session logs, keeps only timed openai-codex gpt-5.6-sol
 * medium assistant calls, and emits aggregate cells. Prompts, messages, cwd,
 * session ids and individual rows never leave this process — only per-cell
 * count/median/IQR are written.
 *
 * This script is never imported by the runtime. The runtime only reads the
 * generated JSON artifact.
 *
 *   node scripts/build-provisional-baseline.mjs \
 *     --sessions ~/.rubato-pi/agent/sessions \
 *     --out data/speed-index-baseline-v0.json
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVISIONAL_ORIGIN, freezeProvisionalBaseline } from "../src/speed-index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFERENCE_MODEL = "gpt-5.6-sol";
const REFERENCE_PROVIDER = "openai-codex";
const REFERENCE_EFFORT = "medium";

function parseArgs(argv) {
  const args = { sessions: join(homedir(), ".rubato-pi", "agent", "sessions"), out: join(HERE, "..", "data", "speed-index-baseline-v0.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--sessions") args.sessions = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--print") args.print = true;
  }
  return args;
}

function* jsonlFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

/**
 * Serialized session rows are not live provider usage. `usage.input` here is the
 * uncached input only, so the full prompt is the sum of all three legs.
 */
function usageOf(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const newInputTokens = Number(usage.input);
  const cacheReadTokens = Number(usage.cacheRead ?? 0);
  const cacheWriteTokens = Number(usage.cacheWrite ?? 0);
  if (![newInputTokens, cacheReadTokens, cacheWriteTokens].every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  const fullInputTokens = newInputTokens + cacheReadTokens + cacheWriteTokens;
  if (fullInputTokens <= 0) return undefined;
  return {
    newInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    fullInputTokens,
    cacheHitRate: cacheReadTokens / fullInputTokens,
  };
}

function modelId(message) {
  const raw = typeof message?.model === "string" ? message.model : "";
  return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
}

function durationOf(message) {
  const value = message?.timing?.modelDurationMs;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Effort provenance is per-session UI state, not a call-boundary record. That is
 * the accepted provisional contamination of v0: the last explicit thinking level
 * before the call is treated as the applied effort.
 */
export function collectProvisionalRows(root) {
  const rows = [];
  const stats = { files: 0, assistant: 0, sol: 0, timed: 0, medium: 0, kept: 0 };
  for (const path of jsonlFiles(root)) {
    stats.files += 1;
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    let effort;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (entry?.type === "thinking_level_change") {
        const selection = entry.thinkingSelection;
        effort = typeof selection?.level === "string" && selection.level.length > 0
          ? selection.level
          : (typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined);
        continue;
      }
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message?.role !== "assistant") continue;
      stats.assistant += 1;
      if (message.provider !== REFERENCE_PROVIDER || modelId(message) !== REFERENCE_MODEL) continue;
      stats.sol += 1;
      if (message.errorMessage) continue;
      const durationMs = durationOf(message);
      if (durationMs === undefined) continue;
      stats.timed += 1;
      if (effort !== REFERENCE_EFFORT) continue;
      stats.medium += 1;
      if (message.stopReason !== "stop" && message.stopReason !== "toolUse") continue;
      const usage = usageOf(message);
      if (!usage) continue;
      stats.kept += 1;
      rows.push({ durationMs, ...usage });
    }
  }
  return { rows, stats };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessions = resolve(args.sessions.startsWith("~/") ? join(homedir(), args.sessions.slice(2)) : args.sessions);
  try { statSync(sessions); } catch {
    console.error(`no session directory at ${sessions}`);
    process.exit(1);
  }
  const { rows, stats } = collectProvisionalRows(sessions);
  const baseline = freezeProvisionalBaseline(rows, { origin: PROVISIONAL_ORIGIN });
  if (baseline.status !== "frozen") {
    console.error(`could not build v0: ${baseline.reason} (${baseline.count}/${baseline.required})`);
    process.exit(1);
  }
  const out = resolve(args.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(baseline, undefined, 2)}\n`);
  console.error(`scanned ${stats.files} session files`);
  console.error(`assistant=${stats.assistant} sol=${stats.sol} timed=${stats.timed} medium=${stats.medium} kept=${stats.kept}`);
  console.error(`cells=${baseline.cells.length} supported=${baseline.supportedCells} hash=${baseline.hash}`);
  console.error(`wrote ${out}`);
  if (args.print) console.log(JSON.stringify(baseline, undefined, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
