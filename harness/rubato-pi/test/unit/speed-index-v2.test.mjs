import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  prepareSpeedV2Profile, scoreSpeedV2, speedV2Identity, validateSpeedV2Profile,
  SPEED_V2_BLOCK_MS, SPEED_V2_REFERENCE,
} from "../../src/speed-index-v2.mjs";
import { readSpeedLogs } from "../../scripts/analyze-speed-index.mjs";
import { createSpeedIndexStore } from "../../src/speed-index-store.mjs";

const start = Date.parse("2026-09-01T08:00:00Z");
const now = start + 3 * SPEED_V2_BLOCK_MS;
const target = { ...SPEED_V2_REFERENCE, model: "target" };

function row({ model = SPEED_V2_REFERENCE.model, day = 0, role = "user", scale = 1, deviceId, ...extra } = {}) {
  return {
    schemaVersion: 1, epoch: "v1", captureVersion: 1,
    at: new Date(start + day * SPEED_V2_BLOCK_MS).toISOString(),
    provider: "openai-codex", model, effort: "medium", effortSource: "options.reasoning",
    streamKind: "main", requestKind: role, terminalStatus: "stop", streamTerminalObserved: true,
    streamEventCount: 6, clientDurationMs: 20_000 * scale,
    newInputTokens: 8192, cacheReadTokens: 8192, cacheWriteTokens: 0, fullInputTokens: 16384, cacheHitRate: 0.5,
    tierCaptureVersion: 1, requestedServiceTier: "unspecified", tierRequestSource: "payload", servedServiceTier: "unknown",
    firstTextMs: 4000 * scale, lastTextMs: 8000 * scale, textCodeUnits: 256, textDeltaCount: 2,
    textMilestones: [[64, 64, 4000 * scale], [256, 256, 8000 * scale]],
    firstToolArgumentMs: 4000 * scale, lastToolArgumentMs: 8000 * scale, toolArgumentCodeUnits: 256, toolArgumentDeltaCount: 2,
    toolArgumentMilestones: [[64, 64, 4000 * scale], [256, 256, 8000 * scale]],
    ...(deviceId ? { deviceId } : {}), ...extra,
  };
}
function rows(options = {}) {
  return [0, 1].flatMap((day) => ["user", "tool"].map((role) => row({ ...options, day, role })));
}
function profile(referenceRows = rows()) {
  const built = prepareSpeedV2Profile(referenceRows, { from: start - 1, to: now });
  assert.equal(built.status, "ready");
  return built.profile;
}

test("the fixed time basket yields one score and keeps the reference scale immutable", () => {
  const frozen = profile();
  assert.equal(frozen.referenceTimeMs, 6000);
  const result = scoreSpeedV2(rows({ model: "target", scale: 0.5 }), target, frozen, { now });
  assert.equal(result.score, 200);
  assert.equal(result.metricVersion, 2);
  assert.equal(result.diagnostics.timeMs, 3000);
  assert.equal(validateSpeedV2Profile(JSON.parse(JSON.stringify(frozen))).hash, frozen.hash);
  assert.equal(validateSpeedV2Profile({ ...frozen, referenceTimeMs: 1000 }), undefined);
  assert.equal(scoreSpeedV2(rows({ scale: 2 }), SPEED_V2_REFERENCE, frozen, { now }).score, 50,
    "current Sol is not forced to 100 after the reference snapshot is frozen");
});

test("extending the output tail or full call duration cannot improve measured prefixes", () => {
  const frozen = profile();
  const a = rows({ model: "target" });
  const b = a.map((sample) => ({
    ...sample, clientDurationMs: 1_000_000, outputTokens: 100_000,
    textCodeUnits: 300, lastTextMs: 900_000,
  }));
  assert.equal(scoreSpeedV2(a, target, frozen, { now }).score, scoreSpeedV2(b, target, frozen, { now }).score);
});

test("fixed roles and devices are not reweighted by replicated tool calls", () => {
  const devices = ["a".repeat(32), "b".repeat(32)];
  const frozen = profile(devices.flatMap((deviceId) => rows({ deviceId })));
  const samples = devices.flatMap((deviceId, i) => rows({ deviceId, model: "target", scale: i + 1 }));
  const duplicated = [...samples, ...Array.from({ length: 100 }, () => samples.filter((sample) =>
    sample.deviceId === devices[0] && sample.requestKind === "tool")).flat()];
  const score = scoreSpeedV2(samples, target, frozen, { now });
  const repeated = scoreSpeedV2(duplicated, target, frozen, { now });
  assert.equal(repeated.score, score.score);
  assert.ok(Math.abs(repeated.diagnostics.timeMs - score.diagnostics.timeMs) < 1e-8);
  assert.equal(scoreSpeedV2(samples.filter((sample) => sample.deviceId === devices[0]), target, frozen, { now }).reason,
    "target_cells", "a missing registered device is not renormalized away");
});

test("an equal startup delay adds once to the basket and a long stall stays in the mean", () => {
  const frozen = profile();
  const delayed = rows({ model: "target" }).map((sample) => ({
    ...sample, clientDurationMs: sample.clientDurationMs + 5000,
    firstTextMs: sample.firstTextMs + 5000, lastTextMs: sample.lastTextMs + 5000,
    firstToolArgumentMs: sample.firstToolArgumentMs + 5000, lastToolArgumentMs: sample.lastToolArgumentMs + 5000,
    textMilestones: sample.textMilestones.map(([k, n, ms]) => [k, n, ms + 5000]),
    toolArgumentMilestones: sample.toolArgumentMilestones.map(([k, n, ms]) => [k, n, ms + 5000]),
  }));
  assert.equal(scoreSpeedV2(delayed, target, frozen, { now }).diagnostics.timeMs, 11_000);
  const samples = [...rows({ model: "target" }), ...rows({ model: "target", scale: 20 })];
  const result = scoreSpeedV2(samples, target, frozen, { now });
  assert.equal(result.score, Math.round(100 / 10.5));
  assert.equal(result.status, "ready", "wide sensitivity does not keep an older faster score");
});

test("every required point must survive removal of one full time block", () => {
  const frozen = profile();
  const single = rows({ model: "target" }).filter((sample) => sample.at === new Date(start).toISOString());
  assert.equal(scoreSpeedV2(single, target, frozen, { now }).reason, "target_blocks");
  const result = scoreSpeedV2(rows({ model: "target" }), target, frozen, { now });
  assert.equal(result.diagnostics.sensitivity.length, 2);
  assert.ok(result.diagnostics.sensitivity.every((item) => item.timeMs === 6000));
  assert.equal(scoreSpeedV2(rows({ model: "target" }), target, frozen, { now: now + 31 * SPEED_V2_BLOCK_MS }).reason,
    "target_cells", "expired support must not retain a stale score");
});

test("missing text never becomes a wait-only score and later errors retain reached points", () => {
  const frozen = profile();
  const noText = rows({ model: "target" }).map(({ textMilestones, firstTextMs, lastTextMs, textCodeUnits, textDeltaCount, ...rest }) => rest);
  assert.equal(scoreSpeedV2(noText, target, frozen, { now }).reason, "target_cells");
  const errors = rows({ model: "target", terminalStatus: "error", networkStatus: "degraded" });
  assert.equal(scoreSpeedV2(errors, target, frozen, { now }).score, 100);
});

test("profile registration uses only reference support, not the easiest common target cells", () => {
  const reference = rows();
  const extraTargets = rows({ model: "target", fullInputTokens: 131072, newInputTokens: 122880 });
  const alone = profile(reference);
  const together = profile([...reference, ...extraTargets]);
  assert.equal(together.hash, alone.hash);
  const oneBlock = reference.filter((sample) => sample.at === new Date(start).toISOString());
  assert.equal(prepareSpeedV2Profile(oneBlock, { from: start - 1, to: now }).reason, "reference_blocks");
  assert.equal(prepareSpeedV2Profile(extraTargets, { from: start - 1, to: now }).reason, "reference_samples");
});

test("uncaptured tiers and one-sided request origins cannot establish a new reference", () => {
  const old = rows().map(({ tierCaptureVersion, ...sample }) => sample);
  assert.equal(prepareSpeedV2Profile(old, { from: start - 1, to: now }).reason, "reference_samples");
  assert.equal(prepareSpeedV2Profile(rows({ role: "user" }).map((sample) => ({ ...sample, requestKind: "user" })),
    { from: start - 1, to: now }).reason, "reference_roles");
  // A component observed from only one role would freeze the other role's weight
  // onto it, so registration closes instead of reweighting.
  for (const onlyRole of ["user", "tool"]) {
    const oneSided = rows().map((sample) => ({ ...sample, requestKind: onlyRole }));
    assert.equal(prepareSpeedV2Profile(oneSided, { from: start - 1, to: now }).reason, "reference_roles");
  }
  const frozen = profile();
  const fast = rows({ model: "target", requestedServiceTier: "priority" });
  assert.equal(scoreSpeedV2(fast, target, frozen, { now }).reason, "target_cells");
  assert.equal(scoreSpeedV2(fast, speedV2Identity(fast[0]), frozen, { now }).score, 100);
  assert.equal(scoreSpeedV2(old, { ...target, tierKey: "unobserved" }, frozen, { now }).reason, "unobserved_tier");
});

test("hour-floored exported times fall in the same day blocks as the raw ones", () => {
  // A corpus can mix raw rows with downloaded exports, and the exporter floors
  // `at` to the hour. Blocks must therefore come from the timestamp itself: an
  // origin taken from the first raw row would put the next day's export back
  // into the first block.
  const raw = Date.parse("2026-09-01T08:17:00Z");
  const exported = Date.parse("2026-09-02T08:37:00Z");
  const mixed = [
    ...[raw].flatMap((at) => ["user", "tool"].map((role) => row({ at: new Date(at).toISOString(), role }))),
    ...[exported].flatMap((at) => ["user", "tool"].map((role) => row({
      at: new Date(Math.floor(at / 3_600_000) * 3_600_000).toISOString(), role,
    }))),
  ];
  const built = prepareSpeedV2Profile(mixed, {
    from: Date.parse("2026-09-01T00:00:00Z"), to: raw + 2 * SPEED_V2_BLOCK_MS,
  });
  assert.equal(built.status, "ready", "the exported day must not collapse into the raw day's block");
  assert.equal(built.diagnostics.blocks, 2);
});

test("exports read from multiple files are deduplicated by explicit identity, not content similarity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "speed-v2-logs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sample = { ...row(), exportVersion: 1, deviceId: "a".repeat(32), recordId: "b".repeat(64) };
  writeFileSync(join(root, "a.jsonl"), `${JSON.stringify(sample)}\n`);
  writeFileSync(join(root, "b.jsonl.gz"), gzipSync(`${JSON.stringify(sample)}\n`));
  const read = readSpeedLogs([root]);
  assert.equal(read.rows.length, 1);
  assert.equal(read.duplicateRecords, 1);
  writeFileSync(join(root, "b.jsonl.gz"), gzipSync(`${JSON.stringify({ ...sample, clientDurationMs: 1 })}\n`));
  assert.throws(() => readSpeedLogs([root]), /conflicting/);
});

test("a registered live store loads history asynchronously and keeps it across session reset", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "speed-v2-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const samplesDir = join(root, "speed-index", "samples");
  mkdirSync(samplesDir, { recursive: true });
  const source = join(samplesDir, `${start}-1-abcd.jsonl`);
  const history = rows({ model: "target", scale: 0.5 });
  writeFileSync(source, history.map((sample) => JSON.stringify(sample)).join("\n") + "\n" + '{"partial":');
  let clock = now;
  const frozen = profile();
  const store = createSpeedIndexStore({
    agentDir: root, now: () => clock, deliveryProfile: frozen, tailMs: 0,
    networkHealth: { start() {}, stop() {} },
  });
  t.after(() => store.stop());
  assert.equal(store.getCachedScore(target).reason, "history_loading");
  // The provider boundary cannot wait: it reads the history it needs for this
  // call instead of stamping the transient loading answer.
  assert.equal(store.getCachedScore(target, { blockOnLoad: true }).score, 200);
  await store.ready();
  const first = store.getCachedScore(target);
  assert.equal(first.score, 200);
  const before = readFileSync(source, "utf8");
  store.resetSession();
  store.setActiveIdentity(target);
  assert.equal(store.getCachedScore().score, 200);
  assert.equal(readFileSync(source, "utf8"), before);
  await store.refreshDeliveryHistory({ force: true });
  assert.equal(store.getCachedScore(target).matched, first.matched, "reloading a file never counts it twice");
  clock += 31 * SPEED_V2_BLOCK_MS;
  assert.equal(store.getCachedScore(target).reason, "target_cells", "expiry invalidates the cached number without a new call");
});

test("the current process is not counted twice and unsupported models never use legacy fallback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "speed-v2-own-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSpeedIndexStore({
    agentDir: root, now: () => now, startedAt: now, deliveryProfile: profile(), tailMs: 0,
    networkHealth: { start() {}, stop() {} },
  });
  t.after(() => store.stop());
  await store.ready();
  for (const sample of rows({ model: "target" })) store.record(sample);
  await store.ready();
  const before = store.getCachedScore(target);
  assert.equal(before.score, 100);
  await store.refreshDeliveryHistory({ force: true });
  assert.equal(store.getCachedScore(target).matched, before.matched);
  assert.equal(store.getCachedScore({ ...target, model: "absent" }).reason, "target_cells");
  assert.equal(store.getCachedScore({ ...target, model: "absent" }).metricVersion, 2);
});

test("a stored profile that lost one role is rejected instead of scoring another basket", () => {
  const frozen = profile();
  const biased = JSON.parse(JSON.stringify(frozen));
  delete biased.hash;
  // Only text:256 loses a role: the wait component keeps both, so a validator
  // that checks wait alone still accepts this basket.
  const text = biased.components.find((component) => component.metric === "text:256");
  const kept = text.cells.filter((cell) => cell.condition.startsWith("tool:"));
  assert.equal(text.cells.length - kept.length, 1, "the fixture must actually lose one cell");
  text.cells = kept.map((cell) => ({ ...cell, weight: cell.weight * (text.cells.length / kept.length) }));
  biased.referenceTimeMs = biased.components.reduce((sum, component) => sum +
    component.cells.reduce((inner, cell) => inner + cell.weight * cell.referenceMeanMs, 0) * component.weight, 0);
  biased.hash = createHash("sha256").update(JSON.stringify(biased)).digest("hex");
  // The same shape with both roles is the valid profile, so the rejection is
  // the missing role and not the recomputed weights or hash.
  assert.ok(validateSpeedV2Profile(frozen));
  assert.equal(validateSpeedV2Profile(biased), undefined);
  assert.equal(scoreSpeedV2(rows({ model: "target" }), target, biased, { now }).reason, "no_profile");
});

test("an unreadable sample directory is not an empty history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "speed-v2-unreadable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A file where the samples directory belongs fails with ENOTDIR, not ENOENT.
  mkdirSync(join(root, "speed-index"), { recursive: true });
  writeFileSync(join(root, "speed-index", "samples"), "not a directory\n");
  const store = createSpeedIndexStore({
    agentDir: root, now: () => now, deliveryProfile: profile(), tailMs: 0,
    networkHealth: { start() {}, stop() {} },
  });
  t.after(() => store.stop());
  await store.ready();
  assert.equal(store.getCachedScore(target).reason, "history_loading",
    "a failed read must stay unloaded rather than score an empty basket");
});

test("profile absence keeps a global legacy mode, but a present invalid profile fails closed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "speed-v2-activation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: root, now: () => now, networkHealth: { start() {}, stop() {} } };
  const legacy = createSpeedIndexStore(options);
  t.after(() => legacy.stop());
  assert.equal(legacy.deliveryMode, false);
  assert.equal(legacy.getCachedScore(target).metricVersion, 1);
  mkdirSync(join(root, "speed-index"), { recursive: true });
  writeFileSync(join(root, "speed-index", "profile-v2.json"), '{"broken":true}\n');
  const invalid = createSpeedIndexStore(options);
  t.after(() => invalid.stop());
  await invalid.ready();
  assert.equal(invalid.deliveryMode, true);
  assert.equal(invalid.getCachedScore(target).reason, "no_profile");
  assert.equal(invalid.getCachedScore(target).metricVersion, 2);
});

test("the transitional live scorer also keeps captured request tiers separate", (t) => {
  const store = createSpeedIndexStore({ networkHealth: { start() {}, stop() {} } });
  t.after(() => store.stop());
  const normal = row({ networkStatus: "healthy", networkSource: "probe" });
  const fast = row({ requestedServiceTier: "priority", networkStatus: "healthy", networkSource: "probe" });
  store.record(normal);
  store.record(fast);
  assert.equal(store.sessionGroups.size, 2);
  assert.equal(store.getCachedScore(normal).valid, 1);
  assert.equal(store.getCachedScore(fast).valid, 1);
});

test("profile CLI is read-only by default, refuses incomplete references and publishes once", (t) => {
  const root = mkdtempSync(join(tmpdir(), "speed-v2-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "input.jsonl");
  const output = join(root, "profile-v2.json");
  const command = new URL("../../scripts/prepare-speed-index-profile.mjs", import.meta.url);
  const env = { ...process.env, HOME: root, USERPROFILE: root,
    RUBATO_PI_CODING_AGENT_DIR: root, SENPI_CODING_AGENT_DIR: root, PI_CODING_AGENT_DIR: root,
    RUBATO_SPEED_INDEX: "0", RUBATO_SPEED_INDEX_PROBE: "0" };
  const run = (...args) => spawnSync(process.execPath, [command.pathname, source, "--from", new Date(start - 1).toISOString(),
    "--to", new Date(now).toISOString(), ...args], { env, encoding: "utf8" });
  writeFileSync(source, rows({ model: "target" }).map((sample) => JSON.stringify(sample)).join("\n") + "\n");
  let result = run("--output", output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).publication, "unavailable_not_written");
  assert.equal(existsSync(output), false);
  writeFileSync(source, rows().map((sample) => JSON.stringify(sample)).join("\n") + "\n");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "ready");
  assert.equal(existsSync(output), false);
  result = run("--output", output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).publication, "written");
  if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(JSON.parse(run("--output", output).stdout).publication, "already_present");
  appendFileSync(source, `${JSON.stringify(row({ day: 1, scale: 2 }))}\n`);
  assert.notEqual(run("--output", output).status, 0);
  assert.equal(validateSpeedV2Profile(JSON.parse(readFileSync(output, "utf8"))).hash, profile().hash);
});
