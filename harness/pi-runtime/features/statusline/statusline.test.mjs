import assert from "node:assert/strict";
import test from "node:test";

import { cacheSnapshot } from "./statusline.mjs";

const MIN = 60_000;
const opus = { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5" };
const turnAt = Date.parse("2026-09-27T03:00:00Z");
const turn = { type: "message", message: { role: "assistant", timestamp: turnAt, usage: { input: 10, cacheRead: 90, cacheWrite: 0 } } };

test("a warmer refresh restarts the cache lifetime", () => {
  const warm = { type: "usage", kind: "cache_warm", timestamp: new Date(turnAt + 40 * MIN).toISOString(), usage: { cacheRead: 90, cacheWrite: 0 } };
  const now = turnAt + 70 * MIN;
  assert.equal(cacheSnapshot([turn], opus, now).state, "cold");
  assert.deepEqual(cacheSnapshot([turn, warm], opus, now), { state: "warm", hitPercent: 90, expiresAt: turnAt + 100 * MIN });
});

test("a scheduled warmer keeps the cache until an hour after its last refresh inside the window", () => {
  // Refreshes at +40m and +80m fall inside the two-hour window; +120m does not.
  const warming = { state: "scheduled", nextWarmAt: turnAt + 40 * MIN, until: turnAt + 120 * MIN, intervalMs: 40 * MIN };
  const snapshot = cacheSnapshot([turn], opus, turnAt + 90 * MIN, warming);
  assert.deepEqual(snapshot, { state: "warm", hitPercent: 90, expiresAt: turnAt + 140 * MIN });
  assert.equal(cacheSnapshot([turn], opus, turnAt + 141 * MIN, warming).state, "cold");
  assert.equal(cacheSnapshot([turn], opus, turnAt + 90 * MIN, { ...warming, state: "inactive" }).state, "cold");
});

test("providers without a published lifetime stay unknown", () => {
  assert.deepEqual(cacheSnapshot([turn], { provider: "xai", id: "grok-4.7" }, turnAt), { state: "unknown", hitPercent: 90 });
});

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };

test("Codex's cache lives 30 minutes from the last request", () => {
  assert.deepEqual(cacheSnapshot([turn], codex, turnAt + 10 * MIN), { state: "warm", hitPercent: 90, expiresAt: turnAt + 30 * MIN });
  assert.equal(cacheSnapshot([turn], codex, turnAt + 31 * MIN).state, "cold");
});

test("a Codex refresh stopped after prefill restarts the lifetime though it reports no usage", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const warm = { type: "usage", kind: "cache_warm", timestamp: new Date(turnAt + 20 * MIN).toISOString(), usage: zero, note: "stopped after prefill" };
  assert.deepEqual(cacheSnapshot([turn, warm], codex, turnAt + 40 * MIN), { state: "warm", hitPercent: 90, expiresAt: turnAt + 50 * MIN });
});

test("a scheduled Codex warmer keeps the cache until 30 minutes after its last refresh inside the window", () => {
  const warming = { state: "scheduled", nextWarmAt: turnAt + 20 * MIN, until: turnAt + 120 * MIN, intervalMs: 20 * MIN };
  // Refreshes at 20, 40, 60, 80 and 100 minutes; the last one holds the cache to 130.
  assert.equal(cacheSnapshot([turn], codex, turnAt + 5 * MIN, warming).expiresAt, turnAt + 130 * MIN);
});

test("an interrupted turn with no reported usage leaves the cache as it was", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const aborted = { type: "message", message: { role: "assistant", stopReason: "aborted", timestamp: turnAt + 5 * MIN, usage: zero } };
  const errored = { type: "message", message: { role: "assistant", stopReason: "error", timestamp: turnAt + 6 * MIN, usage: zero } };
  assert.deepEqual(cacheSnapshot([turn, aborted, errored], opus, turnAt + 10 * MIN), { state: "warm", hitPercent: 90, expiresAt: turnAt + 60 * MIN });
});

test("a request that read nothing from the cache is still a miss", () => {
  const miss = { type: "message", message: { role: "assistant", timestamp: turnAt + 5 * MIN, usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } };
  assert.equal(cacheSnapshot([turn, miss], opus, turnAt + 10 * MIN).state, "cold");
});
