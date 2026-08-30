import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function summary(values) {
  const available = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return available.length === 0 ? { status: "unavailable", available: 0 } : {
    status: "available",
    available: available.length,
    median: percentile(available, 0.5),
    p95: percentile(available, 0.95),
  };
}

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function artifactManifest(runDir) {
  return walk(runDir).filter((path) => basename(path) !== "manifest.json").sort().map((path) => ({
    path: relative(runDir, path),
    bytes: statSync(path).size,
    sha256: digest(path),
  }));
}

export function writeManifest(runDir, metadata = {}) {
  const manifest = { schemaVersion: 1, ...metadata, artifacts: artifactManifest(runDir) };
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function importRun(source, resultRoot, { runNumber = 1, environment, model } = {}) {
  if (!environment) throw new Error("environment label is required");
  const runDir = join(resultRoot, "runs", String(runNumber).padStart(4, "0"));
  if (existsSync(runDir)) throw new Error(`run destination already exists: ${runDir}`);
  mkdirSync(join(resultRoot, "runs"), { recursive: true });
  cpSync(source, runDir, { recursive: true });
  const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
  const inferredModel = model ?? report.calls.find((call) => call.taskId)?.model;
  writeManifest(runDir, { runNumber, environment, model: inferredModel, importedFrom: source, status: "success" });
  return runDir;
}

function runRecord(runDir) {
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  const reportPath = join(runDir, "report.json");
  if (manifest.status !== "success" || !existsSync(reportPath)) return { ...manifest, runDir, backgroundCalls: 0 };
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const task = report.tasks.length === 1 ? report.tasks[0] : undefined;
  const calls = task ? report.calls.filter((call) => call.taskId === task.taskId) : [];
  const backgroundCalls = report.calls.filter((call) => !call.taskId).length;
  return {
    ...manifest,
    runDir,
    backgroundCalls,
    metrics: task ? {
      totalDurationMs: task.totalDurationMs,
      ttftMs: calls[0]?.ttftMs,
      modelDurationMs: task.modelDurationMs,
      toolExecutionMs: task.toolExecutionMs,
      harnessMs: [task.harnessPreModelMs, task.interCallWaitMs, task.harnessPostToolMs].every((value) => typeof value === "number")
        ? task.harnessPreModelMs + task.interCallWaitMs + task.harnessPostToolMs : undefined,
      cacheHitRate: task.usage?.cacheHitRate,
      newInputTokens: task.usage?.newInputTokens,
      costUsd: task.cost?.status === "estimated" ? task.cost.totalUsd : undefined,
    } : undefined,
  };
}

export function aggregateRoot(root) {
  const runsRoot = join(root, "runs");
  const runs = existsSync(runsRoot) ? readdirSync(runsRoot).sort().filter((name) => existsSync(join(runsRoot, name, "manifest.json"))).map((name) => runRecord(join(runsRoot, name))) : [];
  const successful = runs.filter((run) => run.status === "success" && run.metrics);
  const metricNames = ["totalDurationMs", "ttftMs", "modelDurationMs", "toolExecutionMs", "harnessMs", "cacheHitRate", "newInputTokens", "costUsd"];
  return {
    schemaVersion: 1,
    root,
    environment: runs[0]?.environment,
    model: runs[0]?.model,
    repetitions: runs.length,
    successful: successful.length,
    failed: runs.length - successful.length,
    backgroundCalls: runs.reduce((sum, run) => sum + run.backgroundCalls, 0),
    metrics: Object.fromEntries(metricNames.map((name) => [name, summary(successful.map((run) => run.metrics[name]))])),
    runs,
  };
}

export function compareRoots(leftRoot, rightRoot) {
  const left = aggregateRoot(leftRoot);
  const right = aggregateRoot(rightRoot);
  const metrics = {};
  for (const name of Object.keys(left.metrics)) {
    metrics[name] = {};
    for (const statistic of ["median", "p95"]) {
      const a = left.metrics[name][statistic];
      const b = right.metrics[name][statistic];
      metrics[name][statistic] = typeof a === "number" && typeof b === "number" ? { left: a, right: b, delta: b - a, ratio: a === 0 ? undefined : b / a } : { status: "unavailable" };
    }
  }
  return { schemaVersion: 1, left: { root: leftRoot, environment: left.environment, model: left.model }, right: { root: rightRoot, environment: right.environment, model: right.model }, metrics };
}
