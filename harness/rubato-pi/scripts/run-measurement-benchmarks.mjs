#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregateRoot, writeManifest } from "./measurement-benchmark-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export function parseBenchmarkArgs(argv) {
  const args = { repetitions: 1, timeoutMs: 60_000, env: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--root") args.root = argv[++i];
    else if (key === "--env-label") args.environment = argv[++i];
    else if (key === "--model") args.model = argv[++i];
    else if (key === "--repetitions") args.repetitions = Number(argv[++i]);
    else if (key === "--prompt") args.prompt = argv[++i];
    else if (key === "--prices") args.prices = argv[++i];
    else if (key === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (key === "--capture-raw") args.captureRaw = true;
    else if (key === "--set-env") { const [name, ...rest] = argv[++i].split("="); if (!name || rest.length === 0) throw new Error("--set-env requires NAME=VALUE"); args.env[name] = rest.join("="); }
    else throw new Error(`unexpected argument: ${key}`);
  }
  if (!args.root || !args.environment || !args.model || !Number.isInteger(args.repetitions) || args.repetitions < 1 || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("usage: run-measurement-benchmarks.mjs --root DIR --env-label LABEL --model MODEL --repetitions N [--prompt TEXT] [--prices FILE] [--timeout-ms POSITIVE_MS] [--capture-raw] [--set-env NAME=VALUE]");
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseBenchmarkArgs(argv);
  const runsRoot = join(args.root, "runs");
  if (existsSync(runsRoot) && readdirSync(runsRoot).length > 0) throw new Error(`result root already contains runs: ${args.root}`);
  for (let number = 1; number <= args.repetitions; number += 1) {
    const runDir = join(args.root, "runs", String(number).padStart(4, "0"));
    const agentDir = join(runDir, "agent");
    const cwd = join(runDir, "cwd");
    const raw = join(runDir, "raw");
    mkdirSync(agentDir, { recursive: true }); mkdirSync(cwd, { recursive: true });
    if (args.captureRaw) mkdirSync(raw, { recursive: true });
    const rawEnv = args.captureRaw ? { RUBATO_MEASUREMENT_RAW_DIR: raw, RUBATO_MEASUREMENT_CAPTURE_RAW: "1" } : {};
    const env = { ...process.env, ...args.env, RUBATO_SMOKE_RUN_DIR: runDir, RUBATO_SMOKE_CWD: cwd, RUBATO_SMOKE_MODEL: args.model, RUBATO_SMOKE_TIMEOUT_MS: String(args.timeoutMs), RUBATO_MEASUREMENT_LOG: join(runDir, "events.jsonl"), SENPI_CODING_AGENT_DIR: agentDir, RUBATO_NO_UPDATE_CHECK: "1", RUBATO_NO_UPDATE_PROMPT: "1", RUBATO_NO_VAULT: "1", RUBATO_NO_SPLASH: "1", RUBATO_NO_ENGINE_BUILD: "1", ...rawEnv };
    if (args.prompt) env.RUBATO_SMOKE_PROMPT = args.prompt;
    const result = spawnSync(process.execPath, [join(here, "measurement-rpc-smoke.mjs")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(runDir, "driver-result.json"), `${JSON.stringify({ exitCode: result.status, signal: result.signal ?? null, stdout: result.stdout || "" }, null, 2)}\n`);
    writeFileSync(join(runDir, "runner-stderr.log"), result.stderr || "");
    let status = result.status === 0 ? "success" : "failed";
    if (status === "success") {
      const analyzerArgs = [join(here, "analyze-measurements.mjs"), join(runDir, "events.jsonl")];
      if (args.prices) analyzerArgs.push("--prices", args.prices);
      const analyzed = spawnSync(process.execPath, analyzerArgs, { encoding: "utf8" });
      writeFileSync(join(runDir, "report.json"), analyzed.stdout || "");
      if (analyzed.status !== 0) { status = "failed"; writeFileSync(join(runDir, "analyzer-stderr.log"), analyzed.stderr || ""); }
    }
    writeManifest(runDir, { runNumber: number, environment: args.environment, model: args.model, status, exitCode: result.status, signal: result.signal ?? undefined });
  }
  const aggregate = aggregateRoot(args.root);
  writeFileSync(join(args.root, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  if (aggregate.failed > 0) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
