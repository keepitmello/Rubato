import assert from "node:assert/strict";
import test from "node:test";
import { withRubatoStream } from "../../src/rubato-stream.mjs";
import { sanitizeSample } from "../../src/speed-index-store.mjs";
import { exportSpeedSample } from "../../src/speed-data-export.mjs";
import { analyzeSpeedSamples } from "../../src/speed-analysis.mjs";
import {
  createSpeedTierCapture, observeSpeedRequestTier, observeSpeedResponseTier,
  sanitizeSpeedTier, speedTierKey,
} from "../../src/speed-index-tier.mjs";

const model = { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" };
const at = Date.parse("2026-09-22T08:00:00Z");

async function capture({ selected = model, payloads = [{}], callback, messageTier, options = {} } = {}) {
  const rows = [];
  const forwarded = [];
  let clock = 0;
  const stream = withRubatoStream((m, _context, opts) => ({
    async *[Symbol.asyncIterator]() {
      for (const payload of payloads) {
        const result = await opts.onPayload(payload, m);
        forwarded.push(result === undefined ? payload : result);
      }
      yield { type: "text_delta", delta: "x".repeat(256) };
      yield {
        type: "done",
        message: {
          role: "assistant", stopReason: "stop", content: [],
          ...(messageTier === undefined ? {} : { serviceTier: messageTier }),
          usage: { input: 20, cacheRead: 10, cacheWrite: 0, output: 64 },
        },
      };
    },
  }))(selected, { messages: [{ role: "user" }], tools: [{}] }, {
    reasoning: "medium",
    ...options,
    onPayload: callback,
    measurementRecorder: null,
    speedIndexStore: { record: (row) => rows.push(sanitizeSample(row)) },
    monotonic: () => clock++ * 100,
    wallNow: () => at,
  });
  for await (const _event of stream) {}
  return { row: rows[0], forwarded };
}

test("capture observes the final async payload, not an inherited model or option tier", async () => {
  const original = { service_tier: "auto", input: "SECRET" };
  const final = { ...original, service_tier: "priority" };
  const { row, forwarded } = await capture({
    selected: { ...model, serviceTier: "flex" },
    payloads: [original],
    options: { serviceTier: "auto" },
    callback: async (payload, selected) => {
      assert.equal(payload, original);
      assert.equal(selected.id, model.id);
      return final;
    },
  });
  assert.equal(forwarded[0], final);
  assert.equal(row.requestedServiceTier, "priority");
  assert.equal(row.tierRequestSource, "payload");
  assert.equal(row.servedServiceTier, "unknown");
  assert.equal(JSON.stringify(row).includes("SECRET"), false);
});

test("in-place mutation and undefined callback returns retain the provider contract", async () => {
  const payload = {};
  const { row, forwarded } = await capture({
    payloads: [payload], callback: (body) => { body.service_tier = "priority"; },
  });
  assert.equal(forwarded[0], payload);
  assert.equal(row.requestedServiceTier, "priority");
  const disabled = await capture({ selected: { ...model, serviceTier: "priority" } });
  assert.equal(disabled.row.requestedServiceTier, "unspecified");
  assert.equal(disabled.row.servedServiceTier, "unknown", "no override is not a server-confirmed normal tier");
});

test("Anthropic fast is observed from speed rather than OpenAI service_tier", async () => {
  const { row } = await capture({
    selected: { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages" },
    payloads: [{ service_tier: "auto", speed: "fast", betas: ["SECRET"] }],
  });
  assert.equal(row.requestedServiceTier, "fast");
  assert.equal(row.servedServiceTier, "unknown");
  assert.equal(JSON.stringify(row).includes("SECRET"), false);
});

test("requested priority and a server-confirmed default remain distinguishable", async () => {
  const { row } = await capture({ payloads: [{ service_tier: "priority" }], messageTier: "default" });
  assert.equal(speedTierKey(row), "payload:priority:default");
  assert.notEqual(speedTierKey(row), speedTierKey((await capture({ payloads: [{ service_tier: "priority" }] })).row));
});

test("repeated payloads are stable but conflicting attempts are explicitly mixed", async () => {
  const same = await capture({ payloads: [{ service_tier: "priority" }, { service_tier: "priority" }] });
  assert.equal(same.row.requestedServiceTier, "priority");
  const mixed = await capture({ payloads: [{ service_tier: "priority" }, {}, {}] });
  assert.equal(mixed.row.requestedServiceTier, "mixed");
});

test("unobserved history cannot acquire a normal tier and malicious metadata is rebuilt", () => {
  const old = { schemaVersion: 1, epoch: "v1", at: new Date(at).toISOString(), requestedServiceTier: "priority" };
  assert.deepEqual(sanitizeSpeedTier(old), {});
  assert.equal(speedTierKey(old), "unobserved");
  assert.equal(sanitizeSample(old).requestedServiceTier, undefined);
  assert.deepEqual(sanitizeSpeedTier({
    tierCaptureVersion: 1, requestedServiceTier: { body: "SECRET" },
    servedServiceTier: "SECRET", tierRequestSource: "SECRET",
  }), {
    tierCaptureVersion: 1, requestedServiceTier: "unknown",
    tierRequestSource: "unknown", servedServiceTier: "unknown",
  });
});

test("option/model declarations retain weaker provenance until a payload is observed", () => {
  const declared = createSpeedTierCapture({ ...model, serviceTier: "priority" }, {});
  assert.equal(speedTierKey(declared), "model:priority:unknown");
  const option = createSpeedTierCapture(model, { serviceTier: "auto" });
  assert.equal(speedTierKey(option), "options:auto:unknown");
  observeSpeedRequestTier(option, { service_tier: "SECRET" }, model);
  observeSpeedResponseTier(option, { serviceTier: { secret: "SECRET" } });
  assert.equal(speedTierKey(option), "payload:unknown:unknown");
});

test("pseudonymous exports keep only the bounded tier fields and callback failures propagate", async () => {
  const { row } = await capture({ payloads: [{ service_tier: "priority" }] });
  const wire = exportSpeedSample(row, {
    deviceId: "a".repeat(32), secret: "b".repeat(64), recordKey: "fixture:0", from: at - 1, to: at + 1,
  });
  assert.equal(speedTierKey(wire), speedTierKey(row));
  const failure = new Error("caller hook failed");
  await assert.rejects(capture({ callback: () => { throw failure; } }), (error) => error === failure);
});

test("analysis never pools normal requests, fast requests, or uncaptured history", async () => {
  const normal = (await capture()).row;
  const fast = (await capture({ payloads: [{ service_tier: "priority" }] })).row;
  const old = { ...normal };
  for (const key of ["tierCaptureVersion", "requestedServiceTier", "servedServiceTier", "tierRequestSource"]) delete old[key];
  const report = analyzeSpeedSamples([normal, fast, old], { from: at - 1, to: at + 1 });
  assert.deepEqual(report.groups.map((group) => group.identity.tierKey).sort(), [
    "payload:priority:unknown", "payload:unspecified:unknown", "unobserved",
  ]);
  assert.ok(report.groups.every((group) => group.captured === 1));
  const key = report.groups[0].cells[0].key;
  const comparison = analyzeSpeedSamples([normal, fast], {
    from: at - 1, to: at + 1,
    profile: {
      version: 1, id: "explicit-tier", metric: "wait",
      reference: { provider: model.provider, model: model.id, effort: "medium", tierKey: "payload:unspecified:unknown" },
      cells: [{ key, weight: 1 }],
    },
  }).comparison;
  assert.ok(comparison.results.every((result) => result.index === 100));
  const oldReference = analyzeSpeedSamples([normal, fast], {
    from: at - 1, to: at + 1,
    profile: { ...comparison.profile, reference: { provider: model.provider, model: model.id, effort: "medium" } },
  }).comparison;
  assert.ok(oldReference.results.every((result) => result.index === null), "a legacy reference cannot silently choose a new tier");
});
