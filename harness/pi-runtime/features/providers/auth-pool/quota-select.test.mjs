import assert from "node:assert/strict";
import test from "node:test";
import { quotaWeight, selectQuotaSlot } from "./quota-select.mjs";

const now = Date.parse("2026-10-18T12:00:00Z");
const window = (usedPercent, hours, id = "five_hour", windowDurationMins = 300) => ({
  id, usedPercent, resetsAt: new Date(now + hours * 3_600_000).toISOString(), windowDurationMins,
});

test("remaining quota and time to reset both determine sustainable pace", () => {
  assert.equal(quotaWeight([window(50, 5)], "claude-opus-5-5", now), 0.5);
  assert.equal(quotaWeight([window(50, 1)], "claude-opus-5-5", now), 2.5);
  assert.equal(quotaWeight([window(90, 5)], "claude-opus-5-5", now).toFixed(1), "0.1");
});

test("tightest applicable window wins; another model's quota is irrelevant", () => {
  const windows = [window(10, 1), window(100, 12, "seven_day_sonnet", 10080)];
  assert.equal(quotaWeight(windows, "claude-opus-5-5", now), 4.5);
  assert.equal(quotaWeight(windows, "claude-sonnet-5-5", now), 0);
  assert.equal(quotaWeight([...windows, window(100, 24, "seven_day", 10080)], "claude-opus-5-5", now), 0);
});

test("expired and missing measurements have a neutral pace, never an old permanent block", () => {
  assert.equal(quotaWeight([window(100, -1)], "", now), 1);
  assert.equal(quotaWeight(undefined, "", now), 1);
  assert.equal(quotaWeight([{ usedPercent: 100, resetsAt: "bad" }], "", now), 1);
});

test("new sessions spread in proportion to pace before either account exhausts", () => {
  const slots = [{ name: "a" }, { name: "b" }];
  const usage = { a: { windows: [window(50, 5)] }, b: { windows: [window(50, 1)] } };
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 600; i++) {
    counts[selectQuotaSlot(slots, { usage, now, random: () => (i + 0.5) / 600 }).name]++;
  }
  assert.deepEqual(counts, { a: 100, b: 500 });
  usage.a.windows = [window(100, 5)];
  assert.equal(selectQuotaSlot(slots, { usage, now, random: () => 0 }).name, "b");
  usage.b.windows = [window(100, 1)];
  assert.throws(() => selectQuotaSlot(slots, { usage, now }), /exhausted.*reset/);
});
