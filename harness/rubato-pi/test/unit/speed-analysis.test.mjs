import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { analyzeSpeedSamples, deliveryCell, observeDelivery } from "../../src/speed-analysis.mjs";
import { SPEED_CAPTURE_MILESTONES, loadBundledBaseline } from "../../src/speed-index-store.mjs";
import { scoreGroup } from "../../src/speed-index.mjs";
import { readSpeedLogs } from "../../scripts/analyze-speed-index.mjs";

const from = Date.parse("2026-09-01T00:00:00Z");
const to = Date.parse("2026-09-03T00:00:00Z");
const reference = { provider: "test-provider", model: "reference", effort: "medium" };
const cellKey = "user:8192:16384:gte50";
const profile = {
  version: 1, id: "synthetic-wait", metric: "wait", reference,
  cells: [{ key: cellKey, weight: 1 }],
};

function channel(prefix, first, last, units = 300) {
  const title = prefix[0].toUpperCase() + prefix.slice(1);
  return {
    [`first${title}Ms`]: first, [`last${title}Ms`]: last,
    [`${prefix}CodeUnits`]: units, [`${prefix}DeltaCount`]: 2,
    [`${prefix}Milestones`]: SPEED_CAPTURE_MILESTONES.filter((k) => k <= units).map((k) => [k, units, last]),
  };
}

function sample(model = "target", wait = 1000, overrides = {}) {
  return {
    schemaVersion: 1, epoch: "v1", at: "2026-09-01T12:00:00Z",
    provider: "test-provider", model, effort: "medium", effortSource: "options",
    streamKind: "main", requestKind: "user", terminalStatus: "stop",
    networkStatus: "healthy", networkSource: "probe",
    fullInputTokens: 10000, cacheReadTokens: 8000, cacheHitRate: 0.8, outputTokens: 100,
    clientDurationMs: wait + 2000, captureVersion: 1,
    streamEventCount: 4, streamTerminalObserved: true, processId: "synthetic-process",
    ...channel("text", wait, wait + 1000), ...overrides,
  };
}

const analyze = (rows, options = {}) => analyzeSpeedSamples(rows, { from, to, ...options });
const targetIndex = (rows, customProfile = profile) =>
  analyze(rows, { profile: customProfile }).comparison.results.find((row) => row.identity.model === "target");
const withoutText = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !/^(firstText|lastText|text)/.test(key)));

test("wait excludes reasoning and takes the first nonempty text/tool channel", () => {
  const row = sample("target", 5000, { ...channel("reasoning", 10, 100), ...channel("toolArgument", 3000, 4000) });
  assert.equal(observeDelivery(row, "wait").ms, 3000);
  assert.equal(observeDelivery(row, "reasoning:first").ms, 10);
  assert.equal(observeDelivery(withoutText(sample("target", 1000, channel("reasoning", 10, 100))), "wait").missing, "no_channel");
});

test("actual coarse crossings are not interpolated; a burst is not infinite TPS", () => {
  const row = sample("target", 6000, channel("text", 6000, 6000, 1300));
  assert.deepEqual(observeDelivery(row, "text:256"), { ms: 6000, afterFirstMs: 0, actualUnits: 1300 });
  const metric = analyze([row]).groups[0].metrics["text:256"];
  assert.equal(metric.meanMs, 6000);
  assert.equal(metric.afterFirst.meanMs, 0);
  assert.equal(metric.overshootCount, 1);
});

test("extending the tail cannot improve an already measured prefix", () => {
  const base = sample("target", 30000);
  const longer = { ...base, outputTokens: 3000, clientDurationMs: 120000,
    textCodeUnits: 3000, lastTextMs: 119000,
    textMilestones: [...base.textMilestones, [1024, 3000, 119000]] };
  const prefixProfile = { ...profile, metric: "text:256" };
  assert.equal(targetIndex([sample("reference", 10000), base], prefixProfile).index,
    targetIndex([sample("reference", 10000), longer], prefixProfile).index);
});

test("fixed request composition is unaffected by replicating short tool calls", () => {
  const mix = { ...profile, cells: [{ key: cellKey, weight: 0.5 }, { key: cellKey.replace("user:", "tool:"), weight: 0.5 }] };
  const rows = [sample("reference", 10000), sample("reference", 10000, { requestKind: "tool" }),
    sample("target", 20000), sample("target", 1000, { requestKind: "tool" })];
  const before = targetIndex(rows, mix).index;
  assert.ok(Math.abs(targetIndex([...rows, ...Array.from({ length: 100 }, () => rows[3])], mix).index - before) < 1e-10);
  assert.equal(before, 100 * 10000 / 10500);
});

test("a long stall is retained in the mean, and a uniform delay scaling changes the index inversely", () => {
  const rows = [sample("reference", 10000), ...Array.from({ length: 9 }, () => sample("target", 5000)), sample("target", 200000)];
  assert.equal(targetIndex(rows).index, 100 * 10000 / 24500);
  assert.equal(targetIndex([sample("reference", 10000), sample("target", 5000)]).index, 200);
  assert.equal(targetIndex([sample("reference", 10000), sample("target", 10000)]).index, 100);
});

test("missing profile cells never reweight; absent reference cannot yield an index", () => {
  const mix = { ...profile, cells: [{ key: cellKey, weight: 0.5 }, { key: cellKey.replace("user:", "tool:"), weight: 0.5 }] };
  const result = targetIndex([sample("reference"), sample("reference", 1000, { requestKind: "tool" }), sample()], mix);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "target_cells");
  assert.equal(result.index, null);
  assert.deepEqual(result.missing, [cellKey.replace("user:", "tool:")]);
  assert.equal(targetIndex([sample()]).reason, "reference_cells");
});

test("missing outcomes distinguish short, absent, error, cancel, partial and result-only streams", () => {
  assert.equal(observeDelivery(sample(), "text:1024").missing, "normal_short");
  assert.equal(observeDelivery(withoutText(sample()), "text:64").missing, "no_channel");
  assert.equal(observeDelivery(sample("target", 1000, { terminalStatus: "error" }), "text:1024").missing, "error_before");
  assert.equal(observeDelivery(sample("target", 1000, { exclusion: "aborted" }), "text:1024").missing, "cancelled_before");
  assert.equal(observeDelivery(sample("target", 1000, { streamTerminalObserved: false }), "text:1024").missing, "incomplete_stream");
  assert.equal(observeDelivery(withoutText(sample("target", 1000, { streamEventCount: 0, streamTerminalObserved: false })), "wait").missing, "unobserved_stream");
  assert.equal(observeDelivery(sample("target", 1000, { captureVersion: undefined }), "wait").missing, "unsupported_capture");
});

test("reached points survive later errors/cancellations and degraded network is not hidden", () => {
  const report = analyze([
    sample("target", 1000, { terminalStatus: "error" }),
    sample("target", 3000, { terminalStatus: "aborted", exclusion: "aborted", networkStatus: "degraded", streamTerminalObserved: false }),
  ]);
  const group = report.groups[0];
  assert.equal(group.metrics.wait.meanMs, 2000);
  assert.deepEqual(group.metrics.wait.reachedTerminals, { aborted: 1, error: 1 });
  assert.equal(group.network.degraded, 1);
  assert.deepEqual(report.excluded, {});
});

test("tool-block ends are separate diagnostics, never substituted for argument delivery", () => {
  const row = withoutText(sample("target", 1000, { firstToolCallEndMs: 500, lastToolCallEndMs: 2000, toolCallEndCount: 2 }));
  assert.equal(observeDelivery(row, "wait").missing, "no_channel");
  assert.equal(observeDelivery(row, "toolEnd:first").ms, 500);
  assert.equal(observeDelivery(row, "toolEnd:last").ms, 2000);
  assert.throws(() => targetIndex([row], { ...profile, metric: "toolEnd:last" }));
});

test("malformed, negative, nonmonotone, missing and out-of-duration checkpoints are not repaired", () => {
  for (const overrides of [
    { firstTextMs: -1 }, { firstTextMs: NaN }, { lastTextMs: 4000 },
    { textCodeUnits: 63 }, { textDeltaCount: 0 }, { textMilestones: [] },
    { textMilestones: [[64, 300, 2000], [256, 300, 1000]] },
    { textMilestones: [[64, 300, 2000], [256, 300, 4000]] },
    { textMilestones: [[64, 300, 2000], [256, 200, 2000]] },
    { textMilestones: [[64, 300, 2000], [256, 300, 2000, "unexpected"]] },
  ]) assert.equal(observeDelivery(sample("target", 1000, overrides), "text:256").missing, "invalid_capture");
});

test("unknown request/input/cache conditions are retained descriptively but cannot fill a profile", () => {
  for (const overrides of [
    { requestKind: undefined }, { cacheHitRate: 2 }, { fullInputTokens: NaN }, { cacheReadTokens: -1 },
    { cacheHitRate: undefined, cacheReadTokens: undefined },
  ]) {
    const row = sample("target", 1000, overrides);
    assert.equal(deliveryCell(row), undefined);
    const group = analyze([row]).groups[0];
    assert.equal(group.metrics.wait.count, 1);
    assert.equal(group.unknownCondition, 1);
    assert.equal(group.cells.length, 0);
  }
});

test("a common half-open window spans sessions; legacy rows do not acquire new timings", () => {
  const report = analyze([
    sample("target", 1000, { at: new Date(from).toISOString() }),
    sample("target", 3000, { at: "2026-09-02T16:00:00Z", processId: "second" }),
    sample("target", 9000, { at: new Date(to).toISOString() }),
    sample("target", 9000, { at: "not-a-time" }),
    sample("target", 9000, { captureVersion: undefined }),
    sample("target", 9000, { streamKind: "auxiliary" }),
    sample("target", 9000, { exclusion: "cursor_exec_resolved" }),
  ]);
  assert.equal(report.groups[0].metrics.wait.meanMs, 2000);
  assert.equal(report.groups[0].unsupportedCapture, 1);
  assert.deepEqual(report.groups[0].support, { calls: 2, days: 2, hourBlocks: 2, processes: 2 });
  assert.deepEqual(report.excluded, { excluded_stream: 1, non_main: 1, outside_window: 1, timestamp: 1 });
  assert.equal(report.comparison, null);
});

test("zero times are observable, but not a finite speed ratio", () => {
  const rows = [sample("reference", 1000), sample("target", 0)];
  assert.equal(analyze(rows).groups.find((group) => group.identity.model === "target").metrics.wait.meanMs, 0);
  assert.equal(targetIndex(rows).reason, "zero_time_resolution");
});

test("profiles reject implicit weights, duplicate cells, mixed metrics and bad windows", () => {
  for (const bad of [
    { ...profile, cells: [{ key: cellKey, weight: 0.5 }] },
    { ...profile, cells: [{ key: cellKey, weight: 0.5 }, { key: cellKey, weight: 0.5 }] },
    { ...profile, metric: "all" }, { ...profile, reference: {} },
  ]) assert.throws(() => analyze([], { profile: bad }));
  assert.throws(() => analyze([], { from: to }));
  assert.throws(() => analyze([], { to: NaN }));
});

test("legacy replay delegates to the existing math without the live 200-call cap", () => {
  const rows = Array.from({ length: 205 }, (_, index) => sample("target", 1000 + index));
  const baseline = loadBundledBaseline();
  const report = analyze(rows, { baseline });
  assert.deepEqual(report.groups[0].legacyReplay,
    scoreGroup(rows, rows[0], baseline, { now: to, windowMs: to - from, cap: Infinity, minMatched: 1 }));
  assert.match(report.legacyReplay.scope, /not the live/);
});

test("CLI reads JSONL/gzip without writes, deduplicates file paths and reports malformed lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-speed-analysis-"));
  try {
    const path = join(dir, "first.jsonl");
    const bytes = `${JSON.stringify(sample("target", 1000, { prompt: "MUST_NOT_APPEAR" }))}\nnot-json\n`;
    writeFileSync(path, bytes);
    writeFileSync(join(dir, "second.jsonl.gz"), gzipSync(`${JSON.stringify(sample("target", 3000))}\n`));
    const input = readSpeedLogs([dir, path]);
    assert.equal(input.files, 2);
    assert.equal(input.rows.length, 2);
    assert.equal(input.invalidJsonLines, 1);
    const before = readdirSync(dir).sort();
    const cli = fileURLToPath(new URL("../../scripts/analyze-speed-index.mjs", import.meta.url));
    const env = { ...process.env, HOME: dir, USERPROFILE: dir,
      RUBATO_PI_CODING_AGENT_DIR: dir, SENPI_CODING_AGENT_DIR: dir, PI_CODING_AGENT_DIR: dir,
      RUBATO_SPEED_INDEX: "0", RUBATO_SPEED_INDEX_PROBE: "0" };
    const output = execFileSync(process.execPath, [cli, dir, "--from", new Date(from).toISOString(),
      "--to", new Date(to).toISOString(), "--format", "json"], { env, encoding: "utf8" });
    assert.doesNotMatch(output, /MUST_NOT_APPEAR|synthetic-process/);
    const report = JSON.parse(output);
    assert.equal(report.groups[0].metrics.wait.meanMs, 2000);
    assert.equal(report.input.invalidJsonLines, 1);
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.equal(readFileSync(path, "utf8"), bytes);
    const failed = spawnSync(process.execPath, [cli, dir, "--from", "invalid"], { env, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /finite, increasing/);
    assert.equal(failed.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
