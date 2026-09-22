#!/usr/bin/env node
/** Read-only CLI. Does not construct a store (which would prune old samples). */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { analyzeSpeedSamples } from "../src/speed-analysis.mjs";
import { mergeBaselines } from "../src/speed-index.mjs";
import { BASELINE_FILE, loadBaseline, loadBundledBaseline, resolveSpeedIndexAgentDir } from "../src/speed-index-store.mjs";

const HELP = `Usage: node scripts/analyze-speed-index.mjs [samples-dir|file.jsonl[.gz] ...]
  --from ISO       Inclusive window start (default: 30 days before --to)
  --to ISO         Exclusive window end (default: now)
  --profile FILE   Explicit fixed-condition profile; no index without it
  --baseline FILE  Local legacy baseline (bundled baseline remains the fallback)
  --format text|json  Output format (default: text)

Reads numeric Speed logs only. No model calls, writes, uploads, or live-score changes.
Group summaries are descriptive; profile indices are experimental, not causal rankings.`;

export function readSpeedLogs(paths) {
  const files = new Set();
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (/\.jsonl(?:\.gz)?$/.test(name)) files.add(realpathSync(join(path, name)));
      }
    } else files.add(realpathSync(path));
  }
  const rows = [];
  let invalidJsonLines = 0;
  for (const file of [...files].sort()) {
    const bytes = readFileSync(file);
    const text = (file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { invalidJsonLines += 1; }
    }
  }
  // Paths, process IDs and raw rows are deliberately not part of the report.
  return { rows, files: files.size, invalidJsonLines };
}

export function formatSpeedAnalysis(report) {
  const ms = (value) => value === null ? "—" : `${(value / 1000).toFixed(3)}s`;
  const lines = [
    `Offline experimental delivery analysis | ${report.window.from} .. ${report.window.to} (exclusive)`,
    `${report.inputRows} rows | excluded ${JSON.stringify(report.excluded)} | invalid JSON lines ${report.input?.invalidJsonLines ?? 0}`,
    `Legacy replay: ${report.legacyReplay.formula}; ${report.legacyReplay.scope}.`,
    "Descriptive times below use each model's own mix; do not rank models from these averages.",
  ];
  for (const group of report.groups) {
    const { provider, model, effort } = group.identity;
    lines.push(`\n${provider}/${model} [${effort}]: ${group.captured}/${group.rows} captured; ${group.support.days} days, ${group.support.hourBlocks} hour blocks; legacy ${group.legacyReplay.score ?? "—"}`);
    for (const key of ["wait", "text:256", "toolArgument:256", "toolEnd:last"]) {
      const metric = group.metrics[key];
      lines.push(`  ${key}: mean ${ms(metric.meanMs)}, p90 ${ms(metric.p90Ms)}; reached ${metric.count}/${metric.total}; missing ${JSON.stringify(metric.missing)}`);
    }
    lines.push(`  conditions ${group.cells.length}, unknown ${group.unknownCondition}; terminals ${JSON.stringify(group.terminals)}; network ${JSON.stringify(group.network)}`);
  }
  if (report.comparison) {
    lines.push(`\nFixed profile ${report.comparison.profile.id} (${report.comparison.profile.metric}):`);
    for (const row of report.comparison.results) {
      lines.push(`  ${row.identity.provider}/${row.identity.model} [${row.identity.effort}]: ${row.index === null ? `unavailable (${row.reason})` : `${row.index.toFixed(1)} experimental`}`);
    }
  } else lines.push("\nNo profile supplied: no adjusted index calculated.");
  lines.push("No confidence intervals yet; --format json includes per-condition coverage and missing reasons.");
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) { process.stdout.write(`${HELP}\n`); return; }
  const inputs = [];
  const args = { format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--from", "--to", "--profile", "--baseline", "--format"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      args[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else inputs.push(arg);
  }
  if (!["text", "json"].includes(args.format)) throw new Error("--format must be text or json");
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const agentDir = resolveSpeedIndexAgentDir(process.env, home) ?? join(home, ".rubato-pi", "agent");
  const input = readSpeedLogs(inputs.length ? inputs : [join(agentDir, "speed-index", "samples")]);
  const baseline = mergeBaselines(loadBaseline(args.baseline ?? join(agentDir, "speed-index", BASELINE_FILE)), loadBundledBaseline());
  if (args.baseline && !loadBaseline(args.baseline)) throw new Error("explicit legacy baseline is unreadable or invalid");
  const report = analyzeSpeedSamples(input.rows, {
    ...(args.from ? { from: Date.parse(args.from) } : {}),
    ...(args.to ? { to: Date.parse(args.to) } : {}),
    baseline,
    profile: args.profile ? JSON.parse(readFileSync(args.profile, "utf8")) : undefined,
  });
  report.input = { files: input.files, invalidJsonLines: input.invalidJsonLines };
  process.stdout.write(args.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatSpeedAnalysis(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`Speed analysis: ${error.message}`); process.exitCode = 1; }
}
