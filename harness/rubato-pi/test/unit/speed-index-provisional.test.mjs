import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUNDLED_BASELINE_PATH,
  createSpeedIndexStore,
  loadBundledBaseline,
} from "../../src/speed-index-store.mjs";
import {
  LOCAL_ORIGIN,
  PROVISIONAL_ORIGIN,
  REFERENCE_IDENTITY,
  baselineHash,
  formatSpeedIndex,
  freezeBaseline,
  freezeProvisionalBaseline,
  validateBaseline,
} from "../../src/speed-index.mjs";
import { installStatusline } from "../../src/extensions/statusline.mjs";

/** A call in the band the bundled v0 actually covers (64k-128k, cache >= 50%). */
function call(overrides = {}) {
  return {
    schemaVersion: 1,
    epoch: "v1",
    at: new Date().toISOString(),
    provider: REFERENCE_IDENTITY.provider,
    model: REFERENCE_IDENTITY.model,
    effort: REFERENCE_IDENTITY.effort,
    effortSource: "options.reasoning",
    reasoning: true,
    streamKind: "main",
    clientDurationMs: 8000,
    networkStatus: "healthy",
    networkSource: "probe",
    newInputTokens: 20_000,
    cacheReadTokens: 60_000,
    cacheWriteTokens: 0,
    outputTokens: 200,
    fullInputTokens: 80_000,
    cacheHitRate: 0.75,
    terminalStatus: "stop",
    processId: "1-1-a",
    ...overrides,
  };
}

function absentPath() {
  return join(tmpdir(), "speed-index-no-such-v0.json");
}

test("the bundled v0 artifact is a valid provisional baseline of aggregate cells only", () => {
  const bundled = loadBundledBaseline();
  assert.ok(bundled, "bundled v0 must load");
  assert.equal(bundled.origin, PROVISIONAL_ORIGIN);
  assert.equal(bundled.status, "frozen");
  assert.ok(bundled.supportedCells > 0);
  assert.equal(validateBaseline(bundled, { origin: PROVISIONAL_ORIGIN }), bundled);
  // A v0 relabelled as local must not validate: origin is inside the hash.
  assert.equal(validateBaseline({ ...bundled, origin: LOCAL_ORIGIN }), undefined);
  const serialized = JSON.stringify(bundled);
  for (const forbidden of ["prompt", "message", "cwd", "sessionId", "content", "/Users/"]) {
    assert.equal(serialized.includes(forbidden), false, `bundled baseline leaked ${forbidden}`);
  }
  for (const cell of bundled.cells) {
    assert.deepEqual(
      Object.keys(cell).sort(),
      ["cacheBand", "count", "inputHi", "inputLo", "iqrMs", "iqrRatio", "key", "medianMs", "supported"],
    );
  }
});

test("a fresh installation with no local baseline scores from the bundled v0", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-v0-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 1, startedAt: 1, nonce: "a1" });
  assert.equal(store.getLocalBaseline(), undefined);
  assert.equal(store.baselineOrigin(), PROVISIONAL_ORIGIN);
  assert.equal(store.getCalibrationProgress().status, "calibrating");

  // The very first matched call scores. No 500-call wait, no 10/30 floor.
  assert.equal(formatSpeedIndex(store.getCachedScore(REFERENCE_IDENTITY)).text, "Speed —");
  store.record(call());
  const first = store.getCachedScore(REFERENCE_IDENTITY);
  assert.equal(first.status, "ready");
  assert.equal(first.matched, 1);
  assert.match(formatSpeedIndex(first).text, /^Speed \d+$/);
  store.stop();
});

test("a matched call halves and doubles the score against the bundled reference cell", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-v0-ratio-"));
  const bundled = loadBundledBaseline();
  const cell = bundled.cells.find((entry) => entry.key === "65536:131072:gte50" && entry.supported);
  assert.ok(cell, "expected the 64k-128k cached cell to be supported in v0");

  const fast = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 2, startedAt: 2, nonce: "a2" });
  fast.record(call({ clientDurationMs: cell.medianMs / 2 }));
  assert.equal(fast.getCachedScore(REFERENCE_IDENTITY).score, 200);
  fast.stop();

  const slow = createSpeedIndexStore({ agentDir: mkdtempSync(join(tmpdir(), "si-v0-slow-")), autostartProbes: false, pid: 3, startedAt: 3, nonce: "a3" });
  slow.record(call({ clientDurationMs: cell.medianMs * 2 }));
  assert.equal(slow.getCachedScore(REFERENCE_IDENTITY).score, 50);
  // Multiple current-session calls aggregate through the matched-cell ratio math.
  slow.record(call({ clientDurationMs: cell.medianMs * 2 }));
  const aggregated = slow.getCachedScore(REFERENCE_IDENTITY);
  assert.equal(aggregated.matched, 2);
  assert.equal(aggregated.score, 50);
  slow.stop();
});

test("historical samples from other processes never reach the live score", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-hist-"));
  const seed = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 4, startedAt: 4, nonce: "b1" });
  const bundled = loadBundledBaseline();
  const cell = bundled.cells.find((entry) => entry.key === "65536:131072:gte50");
  for (let i = 0; i < 20; i += 1) seed.record(call({ clientDurationMs: cell.medianMs / 4 }));
  assert.equal(seed.getCachedScore(REFERENCE_IDENTITY).matched, 20);
  seed.stop();

  // A new process reads that history for calibration, but starts live scoring empty.
  const fresh = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 5, startedAt: 5, nonce: "b2" });
  assert.ok(fresh.calibration.length >= 20, "history must still feed calibration");
  const live = fresh.getCachedScore(REFERENCE_IDENTITY);
  assert.equal(live.matched, 0);
  assert.equal(formatSpeedIndex(live).text, "Speed —");
  fresh.record(call({ clientDurationMs: cell.medianMs }));
  assert.equal(fresh.getCachedScore(REFERENCE_IDENTITY).matched, 1);
  assert.equal(fresh.getCachedScore(REFERENCE_IDENTITY).score, 100);
  fresh.stop();
});

test("session reset drops the live score; model switch keeps other identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-reset-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 6, startedAt: 6, nonce: "c1" });
  store.record(call());
  assert.equal(store.getCachedScore(REFERENCE_IDENTITY).matched, 1);

  // Model selection only moves the active identity.
  store.clearActiveIdentity();
  assert.equal(store.activeIdentity(), undefined);
  assert.equal(store.getCachedScore(REFERENCE_IDENTITY).matched, 1);

  store.resetSession();
  const afterReset = store.getCachedScore(REFERENCE_IDENTITY);
  assert.equal(afterReset.matched, 0);
  assert.equal(formatSpeedIndex(afterReset).text, "Speed —");
  store.stop();
});

test("the footer resets live samples on session start and switch, not on model select", () => {
  const events = [];
  const store = {
    resetSession() { events.push("reset"); },
    clearActiveIdentity() { events.push("clear"); },
    refresh() { events.push("refresh"); },
    getCachedScore: () => ({ status: "ready", score: 120 }),
  };
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    events: { on() {}, off() {} },
  };
  installStatusline(pi, { speedStore: store });
  handlers.get("session_before_switch")({});
  handlers.get("model_select")({});
  assert.deepEqual(events, ["reset", "clear"]);

  events.length = 0;
  handlers.get("session_start")({}, { ui: {} });
  assert.deepEqual(events, ["reset", "refresh"]);
});

test("clean candidates still reach 500 and the published local v1 supersedes v0", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-promote-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 7, startedAt: 7, nonce: "d1" });
  assert.equal(store.baselineOrigin(), PROVISIONAL_ORIGIN);
  for (let i = 0; i < 499; i += 1) {
    store.record(call({ at: new Date(Date.now() - i * 1000).toISOString() }));
  }
  assert.equal(store.baselineOrigin(), PROVISIONAL_ORIGIN, "v0 stays active while calibrating");
  assert.equal(store.getCalibrationProgress().count, 499);

  store.record(call({ at: new Date().toISOString() }));
  assert.equal(store.getCalibrationProgress().status, "frozen");
  assert.equal(store.baselineOrigin(), LOCAL_ORIGIN);
  assert.equal(store.getLocalBaseline().origin, LOCAL_ORIGIN);

  // A later process prefers the immutable local v1 over the bundled artifact.
  const next = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 8, startedAt: 8, nonce: "d2" });
  assert.equal(next.baselineOrigin(), LOCAL_ORIGIN);
  assert.equal(next.getBaseline().hash, store.getLocalBaseline().hash);
  next.stop();
  store.stop();
});

test("malformed bundled and local baselines fail closed", () => {
  const bundled = loadBundledBaseline();
  const dir = mkdtempSync(join(tmpdir(), "si-bad-"));

  // Tampered cells break the hash.
  const tampered = { ...bundled, cells: bundled.cells.map((cell) => ({ ...cell, medianMs: 1 })) };
  assert.equal(validateBaseline(tampered, { origin: PROVISIONAL_ORIGIN }), undefined);

  const badPath = join(dir, "bad-v0.json");
  writeFileSync(badPath, "{ not json");
  assert.equal(loadBundledBaseline(badPath), undefined);

  const tamperedPath = join(dir, "tampered-v0.json");
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  assert.equal(loadBundledBaseline(tamperedPath), undefined);

  // A local file carrying the bundled origin is not a local baseline.
  const agentDir = mkdtempSync(join(tmpdir(), "si-bad-agent-"));
  const store = createSpeedIndexStore({
    agentDir,
    autostartProbes: false,
    pid: 9,
    startedAt: 9,
    nonce: "e1",
    bundledBaselinePath: tamperedPath,
  });
  assert.equal(store.getBaseline(), undefined);
  store.record(call());
  const result = store.getCachedScore(REFERENCE_IDENTITY);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "no_baseline");
  assert.equal(formatSpeedIndex(result).text, "Speed —");
  store.stop();

  // The absent-file case is the same failure, not a crash.
  const missing = createSpeedIndexStore({
    agentDir: mkdtempSync(join(tmpdir(), "si-missing-")),
    autostartProbes: false,
    pid: 10,
    startedAt: 10,
    nonce: "e2",
    bundledBaselinePath: absentPath(),
  });
  assert.equal(missing.getBaseline(), undefined);
  missing.stop();
});

test("freezeProvisionalBaseline keeps aggregates and rejects a thin corpus", () => {
  const rows = Array.from({ length: 40 }, () => ({ durationMs: 5000, fullInputTokens: 80_000, cacheHitRate: 0.75 }));
  const frozen = freezeProvisionalBaseline(rows);
  assert.equal(frozen.status, "frozen");
  assert.equal(frozen.origin, PROVISIONAL_ORIGIN);
  assert.equal(frozen.calibration.provisional, true);
  assert.equal(frozen.hash, baselineHash(frozen));
  assert.equal(frozen.cells.length, 1);
  assert.equal(frozen.cells[0].count, 40);
  assert.equal(frozen.cells[0].medianMs, 5000);
  assert.equal(validateBaseline(frozen, { origin: PROVISIONAL_ORIGIN }), frozen);

  const thin = freezeProvisionalBaseline(rows.slice(0, 3));
  assert.equal(thin.status, "incomplete");
  assert.equal(thin.reason, "insufficient_reference_calls");

  // A local v1 frozen from real samples is a distinct origin from v0.
  const local = freezeBaseline(
    Array.from({ length: 25 }, (_, i) => call({ at: new Date(Date.now() - i * 1000).toISOString() })),
    { minReferenceCalls: 20 },
  );
  assert.equal(local.origin, LOCAL_ORIGIN);
  assert.notEqual(local.hash, frozen.hash);
});

test("the bundled path resolves inside the harness and is read once, not per render", () => {
  assert.match(BUNDLED_BASELINE_PATH, /rubato-pi\/data\/speed-index-baseline-v0\.json$/);
  const first = loadBundledBaseline();
  assert.equal(loadBundledBaseline(), first, "repeat loads must hit the cache, not the filesystem");
});
