import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSpeedIndexStore, loadBaseline, recordSpeedIndexCall, sanitizeSample, writeBaselineExclusive } from "../../src/speed-index-store.mjs";
import { REFERENCE_IDENTITY, SAMPLE_WINDOW_MS, freezeBaseline, identityKey, validateBaseline } from "../../src/speed-index.mjs";

function valid(overrides = {}) {
  return {
    schemaVersion: 1,
    epoch: "v1",
    at: new Date().toISOString(),
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    effortSource: "options.reasoning",
    reasoning: true,
    streamKind: "main",
    clientDurationMs: 1000,
    networkStatus: "healthy",
    networkSource: "probe",
    newInputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    fullInputTokens: 100,
    cacheHitRate: 0,
    terminalStatus: "stop",
    processId: "x",
    ...overrides,
  };
}

test("allowlist strips prompts/cwd/session; unknown keys never persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-store-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 11, startedAt: 1000, nonce: "aa" });
  const recorded = store.record({
    ...valid(),
    prompt: "SECRET",
    cwd: "/Users/secret",
    sessionId: "sess",
    extra: "nope",
  });
  assert.equal(recorded.prompt, undefined);
  assert.equal(recorded.cwd, undefined);
  const line = readFileSync(store.ownPath, "utf8");
  assert.equal(line.includes("SECRET"), false);
  assert.equal(line.includes("sessionId"), false);
  assert.equal(line.includes("extra"), false);
  assert.equal(sanitizeSample({ schemaVersion: 1, epoch: "v1", at: "x", prompt: "p" }).prompt, undefined);
  store.stop();
});

test("two processes write distinct files without a shared lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-conc-"));
  const a = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 1, startedAt: 10, nonce: "aa" });
  const b = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 2, startedAt: 10, nonce: "bb" });
  a.record(valid({ processId: a.processId, effort: "high" }));
  b.record(valid({ processId: b.processId, effort: "low" }));
  assert.notEqual(a.ownPath, b.ownPath);
  assert.equal(readFileSync(a.ownPath, "utf8").split("\n").filter(Boolean).length, 1);
  assert.equal(readFileSync(b.ownPath, "utf8").split("\n").filter(Boolean).length, 1);
  const reader = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 3, startedAt: 11, nonce: "cc" });
  assert.ok([...reader.groups.values()].flat().length >= 2);
  a.stop(); b.stop(); reader.stop();
});

test("corrupt and torn lines are skipped; neighbors remain", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-torn-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 4, startedAt: 20, nonce: "dd" });
  mkdirSync(store.dir, { recursive: true });
  writeFileSync(store.ownPath, `${JSON.stringify(valid({ effort: "high" }))}\nNOT JSON\n${JSON.stringify(valid({ effort: "low" }))}\n{"schemaVersion":1`);
  const other = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 5, startedAt: 21, nonce: "ee" });
  const efforts = [...other.groups.values()].flat().map((sample) => sample.effort).sort();
  assert.deepEqual(efforts, ["high", "low"]);
  store.stop(); other.stop();
});

test("sample files are mode 0600 and stale files prune at startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-mode-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 6, startedAt: 30, nonce: "ff" });
  store.record(valid());
  assert.equal(statSync(store.ownPath).mode & 0o777, 0o600);
  const staleName = `${Date.now() - SAMPLE_WINDOW_MS - 1000}-9-abcd.jsonl`;
  const stalePath = join(dir, "speed-index", "samples", staleName);
  writeFileSync(stalePath, `${JSON.stringify(valid())}\n`);
  const old = new Date(Date.now() - SAMPLE_WINDOW_MS - 1000);
  utimesSync(stalePath, old, old);
  createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 7, startedAt: Date.now(), nonce: "gg" }).stop();
  assert.equal(existsSync(stalePath), false);
  store.stop();
});

test("getCachedScore is a derivation and stays unavailable without any baseline", () => {
  const store = createSpeedIndexStore({ autostartProbes: false, bundledBaselinePath: join(tmpdir(), "speed-index-absent-v0.json") });
  store.record(valid());
  const result = store.getCachedScore();
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "no_baseline");
  store.stop();
});

test("probe startup is lazy and explicit at the store boundary", () => {
  let starts = 0;
  let stops = 0;
  const store = createSpeedIndexStore({
    autostartProbes: false,
    networkHealth: {
      start() { starts += 1; },
      stop() { stops += 1; },
      classify() { return { status: "unknown", source: "probe" }; },
    },
  });
  assert.equal(starts, 0);
  store.startProbes();
  assert.equal(starts, 1);
  store.stop();
  assert.equal(stops, 1);
});


test("calibration is separate from the 200 score cap and freezes at 500", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-cal-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 8, startedAt: 40, nonce: "hh" });
  for (let i = 0; i < 500; i += 1) {
    store.record(valid({ at: new Date(Date.now() - i * 1000).toISOString() }));
  }
  assert.ok((store.groups.get(identityKey(REFERENCE_IDENTITY)) ?? []).length <= 200);
  assert.equal(store.calibration.length, 500);
  assert.equal(store.getBaseline()?.status, "frozen");
  assert.equal(store.getCalibrationProgress().status, "frozen");
  assert.equal(store.getCalibrationProgress().count, 500);
  assert.equal(statSync(store.baselinePath).mode & 0o777, 0o600);
  store.stop();
});

test("baseline write is atomic no-overwrite; corrupt hash fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-base-"));
  const path = join(dir, "speed-index", "baseline-v1.json");
  const frozen = freezeBaseline(Array.from({ length: 30 }, (_, i) => valid({
    at: new Date(Date.now() - i * 1000).toISOString(),
  })), { minReferenceCalls: 20 });
  assert.equal(frozen.status, "frozen");
  assert.equal(writeBaselineExclusive(path, frozen).ok, true);
  const published = readFileSync(path, "utf8");
  assert.equal(writeBaselineExclusive(path, { ...frozen, hash: "deadbeef" }).reason, "exists");
  assert.equal(readFileSync(path, "utf8"), published);
  assert.equal(loadBaseline(path).hash, frozen.hash);
  const temp = join(dir, "speed-index", ".baseline-v1.json.partial.tmp");
  writeFileSync(temp, JSON.stringify({ ...frozen, hash: "cafef00d" }));
  assert.equal(loadBaseline(path).hash, frozen.hash);
  assert.equal(loadBaseline(temp), undefined);
  writeFileSync(path, `${JSON.stringify({ ...frozen, hash: "deadbeef" })}\n`);
  assert.equal(validateBaseline(JSON.parse(readFileSync(path, "utf8"))), undefined);
  const store = createSpeedIndexStore({
    agentDir: dir,
    autostartProbes: false,
    pid: 9,
    startedAt: 50,
    nonce: "ii",
    bundledBaselinePath: join(tmpdir(), "speed-index-absent-v0.json"),
  });
  assert.equal(store.getLocalBaseline(), undefined);
  assert.equal(store.getBaseline(), undefined);
  assert.equal(store.getCalibrationProgress().status, "calibrating");
  store.stop();
});

test("history ingest and auxiliary/error samples do not replace active identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-id-"));
  const store = createSpeedIndexStore({ agentDir: dir, autostartProbes: false, pid: 10, startedAt: 60, nonce: "jj" });
  store.record(valid({ effort: "medium" }));
  assert.equal(store.activeIdentity().effort, "medium");
  const other = join(store.dir, "70-99-abcd.jsonl");
  writeFileSync(other, `${JSON.stringify(valid({ effort: "high", processId: "other" }))}\n`);
  store._ingestFile(other);
  assert.equal(store.activeIdentity().effort, "medium");
  store.record(valid({ effort: "low", streamKind: "compaction", exclusion: "auxiliary_stream" }));
  store.record(valid({ effort: "low", terminalStatus: "error" }));
  assert.equal(store.activeIdentity().effort, "medium");
  store.clearActiveIdentity();
  assert.equal(store.activeIdentity(), undefined);
  store.setActiveIdentity({ provider: "xai", model: "grok-4.6", effort: "high" });
  assert.equal(store.activeIdentity().model, "grok-4.6");
  store.stop();
});

test("getCachedScore does not scan the filesystem; only this session's own records score", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-cache-"));
  const store = createSpeedIndexStore({
    agentDir: dir,
    autostartProbes: false,
    pid: 12,
    startedAt: 80,
    nonce: "kk",
    tailMs: 0,
  });
  const rows = Array.from({ length: 30 }, (_, i) => valid({ at: new Date(Date.now() - i * 1000).toISOString() }));
  for (const row of rows) store.record(row);
  store.setBaseline(freezeBaseline(rows, { minReferenceCalls: 20 }));
  const first = store.getCachedScore(REFERENCE_IDENTITY);
  assert.equal(first.status, "ready");
  assert.equal(first.matched, 30);
  // Another process's rows are calibration history, not this session's speed.
  const other = join(store.dir, "90-1-ffff.jsonl");
  const extra = Array.from({ length: 10 }, (_, i) => valid({ at: new Date(Date.now() + (i + 1) * 1000).toISOString(), effort: "medium" }));
  writeFileSync(other, extra.map((row) => `${JSON.stringify(row)}`).join("\n") + "\n");
  const stale = store.getCachedScore(REFERENCE_IDENTITY);
  assert.equal(stale.matched, 30);
  store.refresh();
  assert.equal(store.getCachedScore(REFERENCE_IDENTITY).matched, 30);
  store.record(valid({ at: new Date(Date.now() + 20_000).toISOString() }));
  assert.equal(store.getCachedScore(REFERENCE_IDENTITY).matched, 31);
  store.stop();
});

test("recordSpeedIndexCall keeps classifier serverDurationMs; probe message timing is ignored", () => {
  const recorded = [];
  const store = {
    processId: "p",
    record(sample) { recorded.push(sample); return sample; },
    networkHealth: {
      classify: () => ({ status: "healthy", source: "server_duration", serverDurationMs: 222 }),
    },
  };
  recordSpeedIndexCall({
    store,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    options: { streamKind: "main", reasoning: "medium" },
    state: { sentAtMs: 0, sentAtWallMs: Date.now(), monotonic: () => 1000 },
    message: { timing: { serverDurationMs: 333 }, providerUsage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1 } } },
    terminalStatus: "stop",
  });
  assert.equal(recorded[0].serverDurationMs, 222);
  assert.equal(recorded[0].networkSource, "server_duration");
  const probeStore = {
    processId: "p",
    record(sample) { recorded.push(sample); return sample; },
    networkHealth: { classify: () => ({ status: "unknown", source: "probe", reason: "stale_probe", rttMs: 9 }) },
  };
  recordSpeedIndexCall({
    store: probeStore,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    options: { streamKind: "main", reasoning: "medium" },
    state: { sentAtMs: 0, sentAtWallMs: Date.now(), monotonic: () => 1000 },
    message: { timing: { serverDurationMs: 444 }, providerUsage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1 } } },
    terminalStatus: "stop",
  });
  assert.equal(recorded[1].serverDurationMs, undefined);
  assert.equal(recorded[1].networkSource, "probe");
  assert.equal(recorded[1].networkStatus, "unknown");
});
