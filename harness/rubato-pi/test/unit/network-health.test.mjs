import assert from "node:assert/strict";
import test from "node:test";
import {
  PROBE_CLASSIFY_AFTER,
  classifyCallNetwork,
  classifyProviderCall,
  createNetworkHealth,
  probeTarget,
  rttLimit,
} from "../../src/network-health.mjs";
import { SPEED_INDEX_NETWORK_ROUTES } from "../../src/speed-index-routes.mjs";
import { DIRECT_PROVIDER_IDS } from "../../src/provider-direct.mjs";

const ORIGIN = "https://chatgpt.com/backend-api";

function probes(n, { origin = ORIGIN, rttMs = 40, ok = true, start = 0, width = 5 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    origin,
    startMs: start + i * 100,
    endMs: start + i * 100 + width,
    ok,
    rttMs,
  }));
}

test("every direct provider declares a speed-index network route", () => {
  for (const id of DIRECT_PROVIDER_IDS) {
    assert.ok(SPEED_INDEX_NETWORK_ROUTES[id], id);
  }
  assert.equal(SPEED_INDEX_NETWORK_ROUTES.kiro.kind, "unsupported");
  assert.equal(probeTarget("http://127.0.0.1:8990"), undefined);
});

test("Kiro loopback is network_unknown and cannot claim a clean window", () => {
  const verdict = classifyProviderCall({
    providerId: "kiro",
    startMs: 1000,
    endMs: 2000,
    probes: probes(30, { origin: "http://127.0.0.1:8990" }),
  });
  assert.equal(verdict.status, "unknown");
  assert.equal(verdict.reason, "loopback_sidecar");
});

test("a route is classifiable only after 20 successful probes", () => {
  const history = probes(19);
  const callStart = 1900;
  const overlapping = [{ origin: ORIGIN, startMs: callStart, endMs: callStart + 10, ok: true, rttMs: 40 }];
  const early = classifyCallNetwork({ probes: [...history, ...overlapping], startMs: callStart, endMs: callStart + 50, origin: ORIGIN });
  assert.equal(early.status, "unknown");
  assert.equal(early.reason, "insufficient_probes");
  const readyHistory = probes(PROBE_CLASSIFY_AFTER);
  const ready = classifyCallNetwork({
    probes: [...readyHistory, { origin: ORIGIN, startMs: 2000, endMs: 2010, ok: true, rttMs: 40 }],
    startMs: 2000,
    endMs: 2050,
    origin: ORIGIN,
  });
  assert.equal(ready.status, "healthy");
});

test("short calls between probe ticks use the latest prior probe", () => {
  const history = probes(20);
  const priorEnd = history.at(-1).endMs;
  const between = classifyCallNetwork({
    probes: history,
    startMs: priorEnd + 50,
    endMs: priorEnd + 150,
    origin: ORIGIN,
    intervalMs: 15_000,
  });
  assert.equal(between.status, "healthy");
  assert.equal(between.rttMs, 40);
});

test("a prior probe older than one interval is stale and fail-closed", () => {
  const history = probes(20);
  const priorEnd = history.at(-1).endMs;
  const stale = classifyCallNetwork({
    probes: history,
    startMs: priorEnd + 15_001,
    endMs: priorEnd + 15_050,
    origin: ORIGIN,
    intervalMs: 15_000,
  });
  assert.equal(stale.status, "unknown");
  assert.equal(stale.reason, "stale_probe");
});

test("a long call with no follow-up probe after probes stop is unknown", () => {
  const history = probes(20);
  const priorEnd = history.at(-1).endMs;
  const long = classifyCallNetwork({
    probes: history,
    startMs: priorEnd + 50,
    endMs: priorEnd + 50 + 15_001,
    origin: ORIGIN,
    intervalMs: 15_000,
  });
  assert.equal(long.status, "unknown");
  assert.equal(long.reason, "stale_probe");
});

test("failed or outlier probes observed through call end degrade the window", () => {
  const history = probes(20);
  const call = { startMs: 2000, endMs: 2100, origin: ORIGIN, intervalMs: 15_000 };
  const fail = classifyCallNetwork({
    probes: [...history, { origin: ORIGIN, startMs: 2001, endMs: 2010, ok: false, rttMs: 40 }],
    ...call,
  });
  assert.equal(fail.status, "degraded");
  assert.equal(fail.reason, "probe_failure");
  const limit = rttLimit(history.map((probe) => probe.rttMs));
  const fat = classifyCallNetwork({
    probes: [...history, { origin: ORIGIN, startMs: 2001, endMs: 2010, ok: true, rttMs: limit + 1 }],
    ...call,
  });
  assert.equal(fat.status, "degraded");
  assert.equal(fat.reason, "rtt_outlier");
});

test("threshold is median + max(20ms, 6×MAD); equal RTTs allow +20ms", () => {
  const rtts = Array.from({ length: 60 }, () => 50);
  assert.equal(rttLimit(rtts), 70);
  const spread = [...Array.from({ length: 30 }, () => 40), ...Array.from({ length: 30 }, () => 60)];
  const center = 50;
  const mad = 10;
  assert.equal(rttLimit(spread), center + 6 * mad);
});

test("createNetworkHealth never probes loopback and classify uses recorded probes", async () => {
  const connects = [];
  const health = createNetworkHealth({
    autostart: false,
    connect: async ({ host, port }) => {
      connects.push({ host, port });
      return { ok: true, rttMs: 12 };
    },
  });
  assert.ok(!health.origins.some((origin) => origin.includes("127.0.0.1")));
  for (let i = 0; i < 21; i += 1) await health.probeOrigin("https://chatgpt.com/backend-api");
  const last = health.probes.at(-1);
  const verdict = health.classify({
    providerId: "openai-codex",
    startMs: last.startMs,
    endMs: last.endMs + 1,
  });
  assert.equal(verdict.status, "healthy");
  health.stop();
});

test("start warmups to the classify threshold instead of waiting for the 15s interval", async () => {
  const health = createNetworkHealth({
    autostart: false,
    intervalMs: 15_000,
    connect: async () => ({ ok: true, rttMs: 12 }),
  });
  health.start();
  const origin = "https://chatgpt.com/backend-api";
  const deadline = Date.now() + 2_000;
  while (health.probes.filter((probe) => probe.origin === origin).length < PROBE_CLASSIFY_AFTER) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const mine = health.probes.filter((probe) => probe.origin === origin);
  assert.ok(mine.length >= PROBE_CLASSIFY_AFTER, `warmup got ${mine.length}`);
  const last = mine.at(-1);
  const verdict = health.classify({
    providerId: "openai-codex",
    startMs: last.endMs,
    endMs: last.endMs + 1,
  });
  assert.equal(verdict.status, "healthy");
  health.stop();
});
