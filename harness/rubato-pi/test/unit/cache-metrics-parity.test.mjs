import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cacheStatus,
  resolveCachePolicy,
  sessionCacheHitPercent,
} from "../../src/statusline.mjs";
import { collectSessionMetrics } from "../../src/session-metrics.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/remote/cache-metrics-cases.json", import.meta.url),
  "utf8",
));

function latestObservationAt(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (entries[index]?.type !== "message" || message?.role !== "assistant" || !message.usage) continue;
    const at = Number(message.timing?.sentAt ?? message.timestamp);
    if (Number.isFinite(at) && at >= 0) return at;
  }
  return undefined;
}

test("cache metric fixtures characterize the current statusline calculations", () => {
  assert.equal(fixture.schemaVersion, 1);
  for (const entry of fixture.cases) {
    const policy = resolveCachePolicy(entry.model);
    assert.deepEqual(policy, entry.expected.policy, `${entry.name}: policy`);
    assert.equal(sessionCacheHitPercent(entry.entries), entry.expected.hitPercent, `${entry.name}: hit percent`);
    assert.deepEqual(cacheStatus(entry.entries, policy, entry.now), entry.expected.status, `${entry.name}: status`);
  }
});

test("expiry timestamps use the same cache observation and policy as the statusline", () => {
  for (const entry of fixture.cases) {
    const policy = resolveCachePolicy(entry.model);
    const observedAt = latestObservationAt(entry.entries);
    const expiresAt = policy?.kind === "opaque" || observedAt === undefined
      ? null
      : new Date(observedAt + policy.ttlSeconds * 1000).toISOString();
    assert.equal(expiresAt, entry.expected.expiresAt, `${entry.name}: expiresAt`);
    assert.equal(entry.expected.status?.expired ?? false, entry.expected.expired, `${entry.name}: expired`);
  }
});

test("collectSessionMetrics reproduces every cache fixture without a second TTL table", () => {
  for (const entry of fixture.cases) {
    const ctx = {
      model: entry.model,
      sessionManager: { getBranch: () => entry.entries },
      getContextUsage: () => undefined,
    };
    const metrics = collectSessionMetrics(ctx, {}, entry.now);
    assert.equal(metrics.cache.policy, entry.expected.policy.kind, `${entry.name}: policy`);
    assert.equal(metrics.cache.hitPercent ?? null, entry.expected.hitPercent, `${entry.name}: hit percent`);
    assert.equal(metrics.cache.expiresAt ?? null, entry.expected.expiresAt, `${entry.name}: expiresAt`);
    assert.equal(metrics.cache.expired, entry.expected.expired, `${entry.name}: expired`);
  }
});

test("remote metrics preserve statusline model, context, and cache semantics", () => {
  const entry = fixture.cases[0];
  const metrics = collectSessionMetrics({
    model: entry.model,
    thinkingLevel: "high",
    sessionManager: { getBranch: () => entry.entries },
    getContextUsage: () => ({ percent: 27.4, contextWindow: 200_000 }),
  }, {}, entry.now);
  assert.match(metrics.model.label, /Opus.*high/i);
  assert.deepEqual(metrics.context, { usedPercent: 27.4, remainingPercent: 73, windowTokens: 200_000 });
  assert.equal(metrics.cache.expiresAt, entry.expected.expiresAt);
});
