import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { exportSpeedSample } from "../../src/speed-data-export.mjs";
import { analyzeSpeedSamples } from "../../src/speed-analysis.mjs";
import { collectSpeedRows, makeSpeedBatches, syncSpeedData } from "../../scripts/sync-speed-data.mjs";

const now = Date.parse("2026-09-22T12:00:00Z");
const repo = "test-owner/private-speed";
const identity = { deviceId: "a".repeat(32), secret: "b".repeat(64) };
const row = (overrides = {}) => ({
  schemaVersion: 1, epoch: "v1", captureVersion: 1, streamKind: "main",
  at: "2026-09-22T10:37:58.124Z", provider: "openai-codex", model: "gpt-6-astra",
  effort: "xhigh", effortSource: "thinkingSelection", requestKind: "tool",
  processId: "SECRET_PROCESS", terminalStatus: "toolUse", networkStatus: "healthy", networkSource: "probe",
  fullInputTokens: 10000, cacheHitRate: 0.8, outputTokens: 100,
  clientDurationMs: 3000, streamEventCount: 4, streamTerminalObserved: true,
  firstTextMs: 1000, lastTextMs: 2000, textCodeUnits: 300, textDeltaCount: 2,
  textMilestones: [[64, 300, 2000], [256, 300, 2000]],
  prompt: "SECRET_PROMPT", messages: [{ text: "SECRET_BODY" }], apiKey: "SECRET_KEY",
  cwd: "/SECRET_PATH", sessionId: "SECRET_SESSION", ...overrides,
});
const exportRow = (raw, recordKey = "source:0") => exportSpeedSample(raw, { ...identity, recordKey, from: now - 86400000, to: now });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rubato-speed-sync-"));
  const samplesDir = join(dir, "samples");
  mkdirSync(samplesDir);
  const samplePath = join(samplesDir, "123456-123-aabbccdd.jsonl");
  writeFileSync(samplePath, `${JSON.stringify(row())}\n`);
  return { dir, samplesDir, samplePath, statePath: join(dir, "state", "sync.json"), repo, now };
}

function fakeGithub() {
  const blobs = new Map();
  const calls = [];
  let isPrivate = true;
  let writable = true;
  let loseConfirmation = false;
  const api = (method, path, body) => {
    calls.push({ method, path });
    if (path === `repos/${repo}`) return { full_name: repo, private: isPrivate, permissions: { push: writable } };
    if (method === "GET") return blobs.has(path) ? { sha: blobs.get(path).sha } : null;
    assert.equal(method, "PUT");
    assert.equal(blobs.has(path), false, "must not overwrite");
    const bytes = Buffer.from(body.content, "base64");
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    blobs.set(path, { sha, bytes });
    if (loseConfirmation) { loseConfirmation = false; throw new Error("simulated lost confirmation"); }
    return { content: { sha } };
  };
  return { api, blobs, calls, public: () => { isPrivate = false; }, readonly: () => { writable = false; },
    loseNextConfirmation: () => { loseConfirmation = true; } };
}

test("export rebuilds a strict numeric/enum allowlist and pseudonymizes exact identities", () => {
  const exported = exportRow(row({ newInputTokens: { secret: "SECRET_NESTED" },
    text: "SECRET_TEXT", networkRttMs: NaN }));
  assert.doesNotMatch(JSON.stringify(exported), /SECRET/);
  assert.equal(exported.at, "2026-09-22T10:00:00.000Z");
  assert.equal(exported.firstTextMs, 1000);
  assert.equal(exported.newInputTokens, undefined);
  assert.equal(exported.exclusion, undefined);
  assert.equal(exported.networkRttMs, undefined);
  assert.match(exported.processId, /^[a-f0-9]{64}$/);
  assert.match(exported.recordId, /^[a-f0-9]{64}$/);
  assert.equal(exported.recordId, exportRow(row()).recordId);
  assert.notEqual(exported.recordId, exportRow(row(), "source:1").recordId);
  assert.notEqual(exported.processId, exported.recordId);
  assert.equal(exportRow(row({ exclusion: "SECRET_ERROR" })), undefined);
  assert.equal(exportRow(row({ effortSource: "SECRET_UNKNOWN_SOURCE" })).effortSource, "unknown");
});

test("old/auxiliary/out-of-window/invalid-identity rows are not uploaded, nested content cannot leak", () => {
  for (const overrides of [{ captureVersion: undefined }, { streamKind: "auxiliary" },
    { at: "2026-08-01T00:00:00Z" }, { at: "invalid" }, { at: new Date(now).toISOString() },
    { provider: { secret: "SECRET" } }, { model: "bad model\nSECRET" }]) {
    assert.equal(exportRow(row(overrides)), undefined);
  }
  const exported = exportRow(row({ textMilestones: [[64, 300, 2000, "SECRET"], [256, 300, 2000]] }));
  assert.doesNotMatch(JSON.stringify(exported), /SECRET/);
  assert.deepEqual(exported.textMilestones, [[256, 300, 2000]]);
});

test("pseudonymous wire rows still feed the offline analysis without changing elapsed times", () => {
  const exported = exportRow(row());
  const report = analyzeSpeedSamples([exported], { from: now - 86400000, to: now });
  assert.equal(report.groups[0].metrics["text:256"].meanMs, 2000);
  assert.equal(report.groups[0].metrics.wait.meanMs, 1000);
  assert.equal(report.groups[0].support.processes, 1);
});

test("day/device/hash batches are bounded and gzip bytes are deterministic", () => {
  const rows = Array.from({ length: 501 }, (_, i) => exportRow(row(), `source:${i}`));
  const batches = makeSpeedBatches(rows, identity.deviceId);
  assert.deepEqual(batches, makeSpeedBatches(rows, identity.deviceId));
  assert.deepEqual(batches.map((batch) => batch.records), [500, 1]);
  assert.match(batches[0].path, /^samples\/2026-09-22\/a{32}\/[a-f0-9]{64}\.jsonl\.gz$/);
  assert.equal(gunzipSync(Buffer.from(batches[1].content, "base64")).toString().trim(), JSON.stringify(rows[500]));
});

test("dry run has no network or filesystem writes; upload is idempotent and leaves raw input unchanged", () => {
  const f = fixture();
  const remote = fakeGithub();
  try {
    const before = readFileSync(f.samplePath);
    const listing = readdirSync(f.dir);
    const dry = syncSpeedData({ ...f, api: () => { throw new Error("dry run must not use network"); } });
    assert.equal(dry.records, 1);
    assert.deepEqual(readdirSync(f.dir), listing);
    const first = syncSpeedData({ ...f, upload: true, api: remote.api });
    assert.equal(first.uploaded, 1);
    assert.equal(statSync(f.statePath).mode & 0o777, 0o600);
    const second = syncSpeedData({ ...f, upload: true, api: remote.api });
    assert.equal(second.records, 0);
    assert.equal(remote.blobs.size, 1);
    assert.equal(remote.calls.filter((call) => call.method === "PUT").length, 1);
    assert.deepEqual(readFileSync(f.samplePath), before);
    assert.equal(existsSync(`${f.statePath}.lock`), false);
    for (const { bytes } of remote.blobs.values()) assert.doesNotMatch(gunzipSync(bytes).toString(), /SECRET/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("lost upload acknowledgement resumes the exact pending blob before accepting new rows", () => {
  const f = fixture();
  const remote = fakeGithub();
  try {
    remote.loseNextConfirmation();
    assert.throws(() => syncSpeedData({ ...f, upload: true, api: remote.api }), /lost confirmation/);
    const pending = JSON.parse(readFileSync(f.statePath)).pending;
    assert.equal(pending.batches.length, 1);
    appendFileSync(f.samplePath, `${JSON.stringify(row({ at: "2026-09-22T11:10:00Z" }))}\n`);
    const retry = syncSpeedData({ ...f, upload: true, api: remote.api });
    assert.equal(retry.alreadyPresent, 1);
    assert.equal(remote.blobs.size, 1);
    const next = syncSpeedData({ ...f, upload: true, api: remote.api });
    assert.equal(next.uploaded, 1);
    assert.equal(next.records, 1);
    const records = [...remote.blobs.values()].flatMap(({ bytes }) => gunzipSync(bytes).toString().trim().split("\n").map(JSON.parse));
    assert.equal(new Set(records.map((r) => r.recordId)).size, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("privacy and write permission are rechecked, including on retries", () => {
  for (const permission of ["public", "readonly"]) {
    const f = fixture();
    const remote = fakeGithub();
    try {
      remote[permission]();
      assert.throws(() => syncSpeedData({ ...f, upload: true, api: remote.api }), /exact private repository/);
      assert.equal(remote.blobs.size, 0);
      assert.equal(existsSync(f.statePath), false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test("partial lines wait for newline and complete corrupt lines are counted without poisoning neighbors", () => {
  const f = fixture();
  const remote = fakeGithub();
  try {
    const second = JSON.stringify(row({ at: "2026-09-22T11:10:00Z" }));
    appendFileSync(f.samplePath, `broken\n${second.slice(0, 80)}`);
    const first = syncSpeedData({ ...f, upload: true, api: remote.api });
    assert.equal(first.records, 1);
    assert.equal(first.diagnostics.invalidJsonLines, 1);
    appendFileSync(f.samplePath, `${second.slice(80)}\n`);
    assert.equal(syncSpeedData({ ...f, upload: true, api: remote.api }).records, 1);
    assert.equal(syncSpeedData({ ...f, upload: true, api: remote.api }).records, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("repo/source mismatch, concurrent lock and truncated files fail without overwriting data", () => {
  const f = fixture();
  const remote = fakeGithub();
  try {
    syncSpeedData({ ...f, upload: true, api: remote.api });
    assert.throws(() => syncSpeedData({ ...f, repo: "other/repo", upload: true, api: remote.api }), /does not match/);
    writeFileSync(`${f.statePath}.lock`, JSON.stringify({ pid: process.pid }));
    assert.throws(() => syncSpeedData({ ...f, upload: true, api: remote.api }), /another sync/);
    rmSync(`${f.statePath}.lock`);
    writeFileSync(f.samplePath, "");
    assert.throws(() => syncSpeedData({ ...f, upload: true, api: remote.api }), /truncated/);
    assert.equal(remote.blobs.size, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("row limits resume at the exact next byte, including UTF-8 and CRLF records", () => {
  const f = fixture();
  try {
    writeFileSync(f.samplePath, Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(row({ prompt: `민감한 본문 ${i}`, outputTokens: i + 1 }))).join("\r\n") + "\r\n");
    const state = { ...identity, samplesDir: f.samplesDir, cursors: {} };
    const first = collectSpeedRows(state, { now, maxRows: 2 });
    const second = collectSpeedRows({ ...state, cursors: first.cursors }, { now, maxRows: 2 });
    const third = collectSpeedRows({ ...state, cursors: second.cursors }, { now, maxRows: 2 });
    assert.deepEqual([...first.rows, ...second.rows, ...third.rows].map((r) => r.outputTokens), [1, 2, 3, 4, 5]);
    assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.recordId)).size, 5);
    assert.equal(first.diagnostics.rowLimitReached, true);
    assert.equal(third.diagnostics.rowLimitReached, false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a future row is deferred without consuming it or blocking another source file", () => {
  const f = fixture();
  const remote = fakeGithub();
  try {
    writeFileSync(f.samplePath, `${JSON.stringify(row({ at: new Date(now + 1000).toISOString() }))}\n`);
    writeFileSync(join(f.samplesDir, "123457-123-aabbccdd.jsonl"), `${JSON.stringify(row())}\n`);
    const first = syncSpeedData({ ...f, upload: true, api: remote.api });
    assert.equal(first.records, 1);
    assert.equal(first.diagnostics.deferredFutureFiles, 1);
    assert.equal(syncSpeedData({ ...f, now: now + 2000, upload: true, api: remote.api }).records, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI defaults to dry run with explicit repository and never exposes source content or secret", () => {
  const f = fixture();
  try {
    writeFileSync(f.samplePath, `${JSON.stringify(row({ at: new Date(Date.now() - 60000).toISOString() }))}\n`);
    const cli = fileURLToPath(new URL("../../scripts/sync-speed-data.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [cli, "--repo", repo, "--samples", f.samplesDir, "--state", f.statePath], {
      env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, RUBATO_PI_CODING_AGENT_DIR: f.dir,
        SENPI_CODING_AGENT_DIR: f.dir, PI_CODING_AGENT_DIR: f.dir, RUBATO_SPEED_INDEX: "0", RUBATO_SPEED_INDEX_PROBE: "0" },
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.mode, "dry_run");
    assert.equal(result.records, 1);
    assert.doesNotMatch(output, /SECRET|123456-123/);
    assert.equal(existsSync(f.statePath), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
