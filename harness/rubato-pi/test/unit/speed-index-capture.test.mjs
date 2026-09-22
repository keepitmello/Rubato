import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { senpiNested } from "../../src/engine-paths.mjs";
import { withRubatoStream } from "../../src/rubato-stream.mjs";
import { createSpeedIndexStore, sanitizeSample, SPEED_CAPTURE_MILESTONES } from "../../src/speed-index-store.mjs";
import { isScoreableSample, speedRatio } from "../../src/speed-index.mjs";

// Real engine queue/result semantics, with deterministic consumer-arrival clocks.
const { createAssistantMessageEventStream } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/index.js")).href
);
const model = { provider: "openai-codex", id: "gpt-5.6-sol" };

function message(stopReason = "stop", content = []) {
  return {
    role: "assistant", stopReason, content,
    providerUsage: {
      inputTokens: { total: 200, noCache: 100, cacheRead: 100, cacheWrite: 0 },
      outputTokens: { total: 100, reasoning: 60 },
    },
  };
}

function fixture(t, events, times, { result, context = { messages: [{ role: "user", content: "SECRET" }] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "speed-capture-"));
  const store = createSpeedIndexStore({
    agentDir: dir, autostartProbes: false, tailMs: 0,
    networkHealth: { classify: () => ({ status: "healthy", source: "probe" }), stop() {} },
  });
  t.after(() => { store.stop(); rmSync(dir, { recursive: true, force: true }); });
  const clock = [...times];
  const stream = withRubatoStream(() => {
    const native = createAssistantMessageEventStream();
    for (const event of events) native.push(event);
    native.end(result);
    return native;
  })(model, context, {
    env: {}, streamKind: "main", reasoning: "medium", speedIndexStore: store,
    monotonic: () => {
      assert.ok(clock.length > 0, "unexpected extra clock read");
      return clock.shift();
    },
    wallNow: () => 1_800_000_000_000,
  });
  return {
    stream, store, clock,
    samples: () => readFileSync(store.ownPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

async function drain(stream) {
  for await (const _event of stream) { /* consume through the actual decorator */ }
}

test("channel timings and bounded milestones reach JSONL without content or score changes", async (t) => {
  const done = message("toolUse", [{ type: "toolCall", id: "secret-id", name: "secret-tool", arguments: { path: "/SECRET" } }]);
  const fx = fixture(t, [
    { type: "start", partial: done },
    { type: "thinking_delta", delta: "" },
    { type: "thinking_delta", delta: "R" },
    { type: "thinking_delta", delta: "RR" },
    { type: "text_delta", delta: "SECRET".padEnd(80, "x") },
    { type: "text_delta", delta: "y".repeat(80) },
    { type: "toolcall_delta", delta: "SECRET".padEnd(1300, "z") },
    { type: "toolcall_end", contentIndex: 2, toolCall: done.content[0] },
    { type: "done", reason: "toolUse", message: done },
  ], [0, 1000, 1100, 2000, 5000, 6000, 6500, 7000], {
    context: { messages: [{ role: "toolResult", content: [{ type: "text", text: "SECRET" }] }] },
  });
  await drain(fx.stream);
  const [sample] = fx.samples();
  assert.equal(sample.captureVersion, 1);
  assert.equal(sample.requestKind, "tool");
  assert.equal(sample.streamEventCount, 9);
  assert.equal(sample.streamTerminalObserved, true);
  assert.equal(sample.clientDurationMs, 7000);
  assert.equal(sample.firstReasoningMs, 1000);
  assert.equal(sample.lastReasoningMs, 1100);
  assert.equal(sample.reasoningCodeUnits, 3);
  assert.equal(sample.reasoningDeltaCount, 2);
  assert.equal(sample.firstTextMs, 2000);
  assert.equal(sample.lastTextMs, 5000);
  assert.equal(sample.textCodeUnits, 160);
  assert.equal(sample.textDeltaCount, 2);
  assert.equal(sample.textMaxGapMs, 3000);
  assert.equal(sample.maxContentGapMs, 3000);
  assert.deepEqual(sample.textMilestones, [[64, 80, 2000]]);
  assert.deepEqual(sample.toolArgumentMilestones, [[64, 1300, 6000], [256, 1300, 6000], [1024, 1300, 6000]]);
  assert.equal(sample.firstToolArgumentMs, 6000);
  assert.equal(sample.firstToolCallEndMs, 6500);
  assert.equal(sample.lastToolCallEndMs, 6500);
  assert.equal(sample.toolCallEndCount, 1);
  assert.equal(sample.reasoningTokens, 60);
  assert.equal(sample.outputTokens, 100, "never subtract/reinterpret provider output usage");
  assert.equal(isScoreableSample(sample), true);
  const legacy = Object.fromEntries(Object.entries(sample).filter(([key]) => [
    "schemaVersion", "epoch", "at", "provider", "model", "effort", "effortSource", "streamKind",
    "clientDurationMs", "networkStatus", "networkSource", "newInputTokens", "cacheReadTokens",
    "cacheWriteTokens", "outputTokens", "fullInputTokens", "cacheHitRate", "terminalStatus", "processId",
  ].includes(key)));
  assert.equal(speedRatio(sample), speedRatio(legacy));
  const persisted = readFileSync(fx.store.ownPath, "utf8");
  for (const secret of ["SECRET", "secret-id", "secret-tool", "arguments", "content"]) {
    assert.equal(persisted.includes(secret), false, `must not retain ${secret}`);
  }
  assert.equal(fx.clock.length, 0);
});

test("empty frames do not start output clocks; a single burst is not measured throughput", async (t) => {
  const done = message();
  const fx = fixture(t, [
    { type: "start", partial: done },
    { type: "text_start" },
    { type: "thinking_delta", delta: "" },
    { type: "text_delta", delta: "" },
    { type: "toolcall_delta", delta: "" },
    { type: "text_delta", delta: "x".repeat(1000) },
    { type: "done", reason: "stop", message: done },
  ], [0, 5000, 5200]);
  await drain(fx.stream);
  const [sample] = fx.samples();
  assert.equal(done.timing.ttftMs, 5000);
  assert.equal(sample.firstTextMs, 5000);
  assert.equal(sample.lastTextMs, 5000);
  assert.equal(sample.textDeltaCount, 1);
  assert.equal(sample.textMaxGapMs, 0);
  assert.equal(sample.firstReasoningMs, undefined);
  assert.equal(sample.reasoningCodeUnits, undefined);
  assert.equal(sample.firstToolArgumentMs, undefined);
  assert.deepEqual(sample.textMilestones, [[64, 1000, 5000], [256, 1000, 5000]]);
});

test("result-only preserves total time but never fabricates delta timings from final content", async (t) => {
  const done = message("stop", [{ type: "text", text: "SECRET".repeat(1000) }]);
  const fx = fixture(t, [
    { type: "text_delta", delta: "SECRET" },
    { type: "done", reason: "stop", message: done },
  ], [0, 6000], { result: done });
  await fx.stream.result();
  const [sample] = fx.samples();
  assert.equal(sample.streamEventCount, 0);
  assert.equal(sample.streamTerminalObserved, false);
  assert.equal(sample.clientDurationMs, 6000);
  assert.equal(sample.firstTextMs, undefined);
  assert.equal(sample.textCodeUnits, undefined);
  assert.equal(sample.textMilestones, undefined);
  assert.equal(fx.samples().length, 1);
});

test("failure retains observed waiting/output facts and stays out of the existing score", async (t) => {
  const error = { ...message("error"), errorMessage: "SECRET error" };
  const fx = fixture(t, [
    { type: "thinking_delta", delta: "reasoning" },
    { type: "text_delta", delta: "SECRET" },
    { type: "error", reason: "error", error },
  ], [0, 3000, 4000, 9000]);
  await drain(fx.stream);
  const [sample] = fx.samples();
  assert.equal(sample.firstReasoningMs, 3000);
  assert.equal(sample.firstTextMs, 4000);
  assert.equal(sample.clientDurationMs, 9000);
  assert.equal(sample.terminalStatus, "error");
  assert.equal(sample.streamTerminalObserved, true);
  assert.equal(isScoreableSample(sample), false);
  assert.equal(JSON.stringify(sample).includes("SECRET"), false);
});

test("iterator cancellation retains partial timing without claiming a stream terminal", async (t) => {
  const fx = fixture(t, [
    { type: "text_delta", delta: "partial" },
    { type: "text_delta", delta: "not consumed" },
  ], [0, 500, 1000]);
  const iterator = fx.stream[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  const [sample] = fx.samples();
  assert.equal(sample.terminalStatus, "cancelled");
  assert.equal(sample.streamTerminalObserved, false);
  assert.equal(sample.streamEventCount, 1);
  assert.equal(sample.firstTextMs, 500);
  assert.equal(sample.textCodeUnits, 7);
  assert.equal(sample.clientDurationMs, 1000);
  assert.equal(isScoreableSample(sample), false);
});

test("tool block completion is recorded separately even without any argument deltas", async (t) => {
  const done = message("toolUse");
  const fx = fixture(t, [
    { type: "toolcall_start", contentIndex: 0 },
    { type: "toolcall_end", contentIndex: 0 },
    { type: "toolcall_end", contentIndex: 1 },
    { type: "done", reason: "toolUse", message: done },
  ], [0, 700, 1500, 2000]);
  await drain(fx.stream);
  const [sample] = fx.samples();
  assert.equal(sample.firstToolCallEndMs, 700);
  assert.equal(sample.lastToolCallEndMs, 1500);
  assert.equal(sample.toolCallEndCount, 2);
  assert.equal(sample.firstToolArgumentMs, undefined);
  assert.equal(sample.firstTextMs, undefined);
  assert.equal(done.timing.ttftMs, undefined);
});

test("UTF-16 lengths stay additive across surrogate boundaries and milestones stay bounded", async (t) => {
  const done = message();
  const fx = fixture(t, [
    { type: "text_delta", delta: "A😀가".slice(0, 2) },
    { type: "text_delta", delta: "A😀가".slice(2) },
    { type: "text_delta", delta: "x".repeat(70_000) },
    { type: "done", reason: "stop", message: done },
  ], [0, 100, 200, 300, 400]);
  await drain(fx.stream);
  const [sample] = fx.samples();
  assert.equal(sample.textCodeUnits, 70_004);
  assert.equal(sample.textMilestones.length, SPEED_CAPTURE_MILESTONES.length);
  assert.deepEqual(sample.textMilestones.at(-1), [65536, 70004, 300]);
  assert.ok(JSON.stringify(sample).length < 2000, "record size is bounded independently of response length");
});

test("capture allowlist reconstructs numeric tuples and rejects nested content/invalid values", () => {
  const base = { schemaVersion: 1, epoch: "v1", at: "now" };
  const sample = sanitizeSample({
    ...base, captureVersion: 1, requestKind: { secret: "SECRET" },
    streamTerminalObserved: "SECRET", firstTextMs: -1, lastTextMs: Infinity,
    textDeltaCount: 1.2, textCodeUnits: { secret: "SECRET" }, reasoningTokens: "SECRET",
    textMilestones: [
      [64, 80, 10],
      [256, { secret: "SECRET" }, 20],
      [1024, 1100, 30, "SECRET"],
      [4096, 5000, 40],
      [16384, 20_000, -1],
      [65536, 70_000, 50],
    ],
  });
  assert.deepEqual(sample, {
    ...base, captureVersion: 1, textMilestones: [[64, 80, 10], [4096, 5000, 40], [65536, 70000, 50]],
  });
  assert.deepEqual(sanitizeSample({ ...base, captureVersion: 99, firstTextMs: 5 }), base);
  assert.deepEqual(sanitizeSample(base), base, "legacy samples do not acquire made-up capture fields");
});
