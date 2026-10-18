import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQuotaUsageReader } from "./quota-usage.mjs";

test("OAuth usage is cached; external setup-token uses real-call observations without a probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-usage-"));
  try {
    const path = join(dir, "usage.json");
    let now = Date.parse("2026-10-18T12:00:00Z");
    const windows = [{ id: "seven_day", usedPercent: 100, resetsAt: "2026-10-19T10:00:00Z", windowDurationMins: 10080 }];
    const observed = { accounts: { "anthropic/setup-token": { observedAt: new Date(now).toISOString(), windows } } };
    writeFileSync(path, JSON.stringify(observed));
    let calls = 0;
    const read = createQuotaUsageReader({ path, now: () => now, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.headers.authorization, "Bearer oauth");
      return Response.json({ five_hour: { utilization: 10, resets_at: "2026-10-18T14:00:00Z" } });
    } });
    const credential = { type: "oauth", access: "oauth", refresh: "refresh", expires: now + 999_999 };
    const usage = await read(credential);
    assert.equal(usage.default.windows[0].usedPercent, 10);
    assert.deepEqual(usage["setup-token"].windows, windows);
    await Promise.all([read(credential), read(credential)]);
    assert.equal(calls, 1);
    now += 60_001;
    observed.accounts["anthropic/setup-token"].windows[0].usedPercent = 99;
    writeFileSync(path, JSON.stringify(observed));
    assert.equal((await read(credential))["setup-token"].windows[0].usedPercent, 99);
    assert.equal(calls, 2);
    await read({ type: "api_key", key: "setup-key" });
    assert.equal(calls, 2, "an API/setup token must never hit the OAuth usage endpoint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage failures fall back to observations and never refresh OAuth credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-failure-"));
  try {
    const path = join(dir, "usage.json");
    const seen = { observedAt: new Date(Date.now() - 120_000).toISOString(), windows: [{ id: "five_hour", usedPercent: 20 }] };
    writeFileSync(path, JSON.stringify({ accounts: { "anthropic/default": seen } }));
    let calls = 0;
    const read = createQuotaUsageReader({ path, fetchImpl: async () => { calls++; return new Response(null, { status: 429 }); } });
    const credential = { type: "oauth", access: "oauth", refresh: "unused-refresh", expires: Date.now() + 60_000 };
    assert.deepEqual((await read(credential)).default, seen);
    await read(credential);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh observations are reused across readers instead of probing OAuth again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-shared-"));
  try {
    const path = join(dir, "usage.json");
    const entry = { observedAt: new Date().toISOString(), windows: [{ id: "five_hour", usedPercent: 20 }] };
    writeFileSync(path, JSON.stringify({ accounts: { "anthropic/default": entry } }));
    let calls = 0;
    const read = createQuotaUsageReader({ path, fetchImpl: async () => { calls++; throw new Error("must not probe"); } });
    const credential = { type: "oauth", access: "oauth", expires: Date.now() + 60_000 };
    assert.deepEqual((await read(credential)).default, entry);
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
