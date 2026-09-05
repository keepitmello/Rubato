import assert from "node:assert/strict";
import test from "node:test";
import {
  REFERENCE_IDENTITY,
  cacheBand,
  cacheHitRate,
  effectiveDuration,
  formatSpeedIndex,
  freezeBaseline,
  fullInputTokens,
  inputBand,
  iqr,
  isScoreableSample,
  mergeBaselines,
  sampleCell,
  scoreFromRatios,
  scoreGroup,
  speedRatio,
} from "../../src/speed-index.mjs";

const now = 1_700_000_000_000;

function sample(overrides = {}) {
  return {
    schemaVersion: 1,
    epoch: "v1",
    at: new Date(now).toISOString(),
    provider: REFERENCE_IDENTITY.provider,
    model: REFERENCE_IDENTITY.model,
    effort: REFERENCE_IDENTITY.effort,
    effortSource: "options.reasoning",
    reasoning: true,
    streamKind: "main",
    clientDurationMs: 1000,
    networkStatus: "healthy",
    networkSource: "probe",
    newInputTokens: 4096,
    cacheReadTokens: 4096,
    cacheWriteTokens: 0,
    outputTokens: 100,
    fullInputTokens: 8192,
    cacheHitRate: 0.5,
    terminalStatus: "stop",
    processId: "1-1-a",
    ...overrides,
  };
}

function many(n, overrides) {
  return Array.from({ length: n }, (_, i) => sample({
    at: new Date(now - i * 1000).toISOString(),
    ...overrides,
  }));
}

test("power-of-two input bands and cache split; output length is not a cell axis", () => {
  assert.deepEqual(inputBand(8192), { lo: 8192, hi: 16384 });
  assert.deepEqual(inputBand(8191), { lo: 4096, hi: 8192 });
  assert.deepEqual(inputBand(0), { lo: 0, hi: 1 });
  assert.equal(cacheBand(0.49), "lt50");
  assert.equal(cacheBand(0.5), "gte50");
  const short = sampleCell(sample({ outputTokens: 10 }));
  const long = sampleCell(sample({ outputTokens: 50_000 }));
  assert.equal(short.key, long.key);
  assert.equal(short.key, "8192:16384:gte50");
});

test("IQR / median > 1.0 leaves a cell unsupported; sparse cells never borrow", () => {
  const tight = many(20, { clientDurationMs: 1000 });
  const sparse = many(19, { newInputTokens: 20000, cacheReadTokens: 0, fullInputTokens: 20000, cacheHitRate: 0 });
  const wild = many(20, { newInputTokens: 1000, cacheReadTokens: 0, fullInputTokens: 1000, cacheHitRate: 0 }).map((row, i) => ({
    ...row,
    clientDurationMs: i < 10 ? 100 : 10_000,
  }));
  const baseline = freezeBaseline([...tight, ...sparse, ...wild], { now: () => now, minReferenceCalls: 20 });
  assert.equal(baseline.status, "frozen");
  const byKey = Object.fromEntries(baseline.cells.map((cell) => [cell.key, cell]));
  assert.equal(byKey["8192:16384:gte50"].supported, true);
  assert.equal(byKey["16384:32768:lt50"].supported, false);
  assert.equal(byKey["16384:32768:lt50"].count, 19);
  assert.ok(byKey["512:1024:lt50"].iqrRatio > 1);
  assert.equal(byKey["512:1024:lt50"].supported, false);
  assert.equal(speedRatio(sample({ fullInputTokens: 20000, newInputTokens: 20000, cacheReadTokens: 0, cacheHitRate: 0 }), baseline), undefined);
});

test("baseline 100, 2x and 0.5x ratios, median-log aggregation", () => {
  const reference = many(20);
  const baseline = freezeBaseline(reference, { now: () => now, minReferenceCalls: 20 });
  const same = sample();
  assert.equal(speedRatio(same, baseline), 1);
  assert.equal(speedRatio(sample({ clientDurationMs: 500 }), baseline), 2);
  assert.equal(speedRatio(sample({ clientDurationMs: 2000 }), baseline), 0.5);
  assert.equal(scoreFromRatios([1, 1, 1]), 100);
  assert.equal(scoreFromRatios([2, 2, 2]), 200);
  assert.equal(scoreFromRatios([0.5, 0.5, 0.5]), 50);
  assert.equal(scoreFromRatios([0.5, 1, 2]), 100);
});

test("one matched call scores; zero matched is a dash; no baseline is unavailable", () => {
  const baseline = freezeBaseline(many(20), { now: () => now, minReferenceCalls: 20 });
  const identity = REFERENCE_IDENTITY;
  const opts = { now };
  assert.equal(scoreGroup([], identity, undefined, opts).reason, "no_baseline");
  assert.equal(formatSpeedIndex(scoreGroup([], identity, baseline, opts)).text, "Speed —");
  const single = scoreGroup(many(1), identity, baseline, opts);
  assert.equal(single.status, "ready");
  assert.equal(single.matched, 1);
  assert.equal(formatSpeedIndex(single).text, "Speed 100");
  const ready = scoreGroup(many(30), identity, baseline, opts);
  assert.equal(ready.status, "ready");
  assert.equal(formatSpeedIndex(ready).text, "Speed 100");
  // An unmatched cell contributes nothing but never blocks the matched ones.
  const unmatched = sample({ newInputTokens: 1000, cacheReadTokens: 0, fullInputTokens: 1000, cacheHitRate: 0, clientDurationMs: 1000 });
  const mixed = [...many(2), ...Array.from({ length: 20 }, () => unmatched)];
  const covered = scoreGroup(mixed, identity, baseline, opts);
  assert.equal(covered.status, "ready");
  assert.equal(covered.matched, 2);
  assert.equal(formatSpeedIndex(covered).text, "Speed 100");
});

test("mergeBaselines keeps bundled coverage where local cells are unsupported", () => {
  const local = freezeBaseline(many(20, { fullInputTokens: 300, cacheHitRate: 0.8, cacheReadTokens: 240, newInputTokens: 60, cacheWriteTokens: 0 }), { now: () => now, minReferenceCalls: 20 });
  const bundled = freezeBaseline(many(20, { fullInputTokens: 80_000, cacheHitRate: 0.75, cacheReadTokens: 60_000, newInputTokens: 20_000, cacheWriteTokens: 0 }), { now: () => now, minReferenceCalls: 20 });
  assert.equal(local.status, "frozen");
  assert.equal(bundled.status, "frozen");
  const merged = mergeBaselines(local, bundled);
  const byKey = Object.fromEntries(merged.cells.map((cell) => [cell.key, cell]));
  assert.equal(byKey["256:512:gte50"]?.supported, true);
  assert.equal(byKey["65536:131072:gte50"]?.supported, true);
  assert.equal(speedRatio(sample({ fullInputTokens: 80_000, cacheHitRate: 0.75, cacheReadTokens: 60_000, newInputTokens: 20_000, clientDurationMs: 1000 }), local), undefined);
  assert.equal(speedRatio(sample({ fullInputTokens: 80_000, cacheHitRate: 0.75, cacheReadTokens: 60_000, newInputTokens: 20_000, clientDurationMs: 1000 }), merged), 1);
  assert.equal(mergeBaselines(undefined, bundled), bundled);
  assert.equal(mergeBaselines(local, undefined), local);
});

test("undersized fullInputTokens and cacheHitRate>1 recompute from cache parts", () => {
  const claude = sample({
    newInputTokens: 0,
    cacheReadTokens: 92_060,
    cacheWriteTokens: 1_317,
    fullInputTokens: 4,
    cacheHitRate: 23_015,
  });
  assert.equal(fullInputTokens(claude), 93_377);
  assert.ok(Math.abs(cacheHitRate(claude) - 92_060 / 93_377) < 1e-9);
  assert.equal(sampleCell(claude).key, "65536:131072:gte50");
});

test("unknown effort, degraded network, auxiliary stream, and errors are unscoreable", () => {
  assert.equal(isScoreableSample(sample({ effort: undefined, effortSource: "unknown" })), false);
  assert.equal(isScoreableSample(sample({ networkStatus: "degraded" })), false);
  assert.equal(isScoreableSample(sample({ networkStatus: "unknown" })), true);
  assert.equal(isScoreableSample(sample({ streamKind: "compaction" })), false);
  assert.equal(isScoreableSample(sample({ terminalStatus: "error" })), false);
  assert.equal(isScoreableSample(sample({ terminalStatus: "aborted" })), false);
  assert.equal(isScoreableSample(sample({ exclusion: "cursor_exec_resolved" })), false);
  assert.equal(effectiveDuration(sample({ networkStatus: "healthy", clientDurationMs: 800 })), 800);
  assert.equal(effectiveDuration(sample({
    networkStatus: "healthy",
    networkSource: "probe",
    clientDurationMs: 800,
    serverDurationMs: 350,
  })), 800);
  assert.equal(effectiveDuration(sample({
    networkStatus: "unknown",
    networkSource: "probe",
    clientDurationMs: 800,
    serverDurationMs: 350,
  })), 800);
  assert.equal(effectiveDuration(sample({
    networkStatus: "degraded",
    networkSource: "probe",
    clientDurationMs: 800,
    serverDurationMs: 350,
  })), undefined);
  assert.equal(effectiveDuration(sample({
    networkStatus: "unknown",
    networkSource: "server_duration",
    clientDurationMs: 800,
    serverDurationMs: 350,
  })), 350);
});

test("legacy measurement-shaped rows cannot become a v1 baseline", () => {
  const legacy = many(30).map(({ networkStatus, networkSource, effort, effortSource, ...rest }) => ({
    ...rest,
    prompt: "do not import",
  }));
  const baseline = freezeBaseline(legacy, { now: () => now, minReferenceCalls: 20 });
  assert.equal(baseline.status, "incomplete");
});
