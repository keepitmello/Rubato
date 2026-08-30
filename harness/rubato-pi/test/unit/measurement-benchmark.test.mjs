import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { aggregateRoot, compareRoots, importRun, percentile, writeManifest } from "../../scripts/measurement-benchmark-lib.mjs";
import { parseBenchmarkArgs } from "../../scripts/run-measurement-benchmarks.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/measurement-benchmark-runs.json", import.meta.url), "utf8"));

function makeRoot(values = fixture) {
  const root = mkdtempSync(join(tmpdir(), "rubato-benchmark-test-"));
  values.forEach((metrics, index) => {
    const run = join(root, "runs", String(index + 1).padStart(4, "0"));
    mkdirSync(run, { recursive: true });
    const taskId = `s:${index + 1}`;
    writeFileSync(join(run, "events.jsonl"), "{}\n");
    writeFileSync(join(run, "report.json"), JSON.stringify({
      calls: [
        { callId: `c${index}`, taskId, ttftMs: metrics.ttftMs, model: "fixture/model" },
        ...Array.from({ length: metrics.backgroundCalls }, (_, n) => ({ callId: `bg${index}-${n}`, model: "title/model" })),
      ],
      tasks: [{ taskId, totalDurationMs: metrics.totalDurationMs, modelDurationMs: metrics.modelDurationMs, toolExecutionMs: metrics.toolExecutionMs, harnessPreModelMs: metrics.harnessMs, interCallWaitMs: 0, harnessPostToolMs: 0, usage: { cacheHitRate: metrics.cacheHitRate, newInputTokens: metrics.newInputTokens }, cost: { status: "estimated", totalUsd: metrics.costUsd } }],
      tools: [],
    }));
    writeManifest(run, { runNumber: index + 1, environment: "fixture", model: "fixture/model", status: "success" });
  });
  return root;
}

test("runner validates positive finite repetitions and timeout", () => {
  const base = ["--root", "/tmp/r", "--env-label", "e", "--model", "m"];
  assert.throws(() => parseBenchmarkArgs([...base, "--repetitions", "0"]), /usage/);
  assert.throws(() => parseBenchmarkArgs([...base, "--repetitions", "1", "--timeout-ms", "0"]), /usage/);
  assert.throws(() => parseBenchmarkArgs([...base, "--repetitions", "1", "--timeout-ms", "Infinity"]), /usage/);
  assert.equal(parseBenchmarkArgs([...base, "--repetitions", "2", "--timeout-ms", "10"]).repetitions, 2);
});

test("nearest-rank statistics preserve outliers", () => {
  assert.equal(percentile([100, 200, 300, 400, 1000], 0.5), 300);
  assert.equal(percentile([100, 200, 300, 400, 1000], 0.95), 1000);
});

test("aggregator reports task metrics and counts background calls separately", () => {
  const report = aggregateRoot(makeRoot());
  assert.equal(report.repetitions, 5);
  assert.equal(report.successful, 5);
  assert.equal(report.failed, 0);
  assert.equal(report.backgroundCalls, 4);
  assert.deepEqual(report.metrics.totalDurationMs, { status: "available", available: 5, median: 300, p95: 1000 });
  assert.equal(report.metrics.ttftMs.median, 30);
  assert.equal(report.metrics.harnessMs.p95, 150);
  assert.equal(report.metrics.costUsd.p95, 0.10);
});

test("failures remain in the run set and unavailable values are explicit", () => {
  const root = makeRoot(fixture.slice(0, 1));
  const failed = join(root, "runs", "0002");
  mkdirSync(failed, { recursive: true });
  writeFileSync(join(failed, "runner-stderr.log"), "provider failed\n");
  writeManifest(failed, { runNumber: 2, environment: "fixture", model: "fixture/model", status: "failed", exitCode: 1 });
  const report = aggregateRoot(root);
  assert.equal(report.repetitions, 2);
  assert.equal(report.successful, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.runs[1].status, "failed");
});

test("import copies artifacts, writes hashes, and comparisons report deltas", () => {
  const sourceRoot = makeRoot(fixture.slice(0, 1));
  const source = join(sourceRoot, "runs", "0001");
  const importedRoot = mkdtempSync(join(tmpdir(), "rubato-benchmark-import-"));
  const imported = importRun(source, importedRoot, { environment: "baseline", model: "fixture/model" });
  const manifest = JSON.parse(readFileSync(join(imported, "manifest.json"), "utf8"));
  assert.equal(manifest.importedFrom, source);
  assert.ok(manifest.artifacts.some((artifact) => artifact.path === "events.jsonl" && artifact.sha256.length === 64));
  const comparison = compareRoots(importedRoot, makeRoot(fixture.slice(1, 2)));
  assert.equal(comparison.metrics.totalDurationMs.median.delta, 100);
  assert.equal(comparison.metrics.totalDurationMs.median.ratio, 2);
});
