import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulate, priceUsage } from "../../scripts/lib/context-cost-model.mjs";
import { auditSession } from "../../scripts/context-cost-audit.mjs";
import { runSimulation } from "../../scripts/context-cost-simulate.mjs";

const rates = { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50,
  longThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5 };
const fable = { ...rates, cacheRead: 0.25, longThreshold: undefined };
const usage = (more = {}) => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, ...more });
const trace = (n = 10) => ({ formatVersion: 1, calls: Array.from({ length: n }, () => ({ newTokens: 10000, outputTokens: 1000, gapMs: 1000 })) });
const settings = { thresholdTokens: 80000, contextWindowTokens: 272000 };
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-9, `${a} != ${b}`);

test("usage prices input and cache separately, not as overlapping totals", () => {
  near(priceUsage(usage({ input: 1000, cacheRead: 10000, cacheWrite: 2000, output: 1000 }), rates).total, .095);
});
test("one-hour writes are a subset, not another full write charge", () => {
  near(priceUsage(usage({ cacheWrite: 4000, cacheWrite1h: 1000 }), rates).total, .0575);
  assert.throws(() => priceUsage(usage({ cacheWrite: 10, cacheWrite1h: 11 }), rates), /부분집합/);
});
test("Astra exactly at 272K has no long-context surcharge", () => {
  assert.equal(priceUsage(usage({ cacheRead: 272000 }), rates).longContext, false);
  near(priceUsage(usage({ cacheRead: 272000 }), rates).total, .272);
  near(priceUsage(usage({ cacheRead: 272001 }), rates).total, .544002);
});
test("Fable cache read ratio is represented by rates rather than a hardcoded ratio", () => {
  near(priceUsage(usage({ cacheRead: 100000 }), fable).total, .025);
});
test("invalid or missing rate inputs fail rather than reporting NaN", () => {
  assert.throws(() => priceUsage(usage({ input: -1 }), rates));
  assert.throws(() => priceUsage(usage({ input: 300000 }), { ...rates, longInputMultiplier: undefined }));
  assert.throws(() => priceUsage(usage(), { ...rates, output: NaN }));
});
test("one-call fixed workload does not force a terminal compaction", () => {
  const r = simulate(trace(1), settings, rates);
  assert.equal(r.transitions, 0); assert.equal(r.totalCalls, 1);
  near(r.totalCostUSD, 18000 * 12.5 / 1e6 + .05);
});
test("TTL expiry removes cache reuse and increases cold-write cost", () => {
  const a = trace(2), b = trace(2); b.calls[1].gapMs = 300000;
  const warm = simulate(a, settings, rates), cold = simulate(b, settings, rates);
  assert.equal(cold.cacheReadTokens, 0); assert.ok(warm.cacheReadTokens > 0);
  assert.ok(cold.totalCostUSD > warm.totalCostUSD);
});
test("fixed productive calls and output are retained across thresholds", () => {
  const a = simulate(trace(30), { ...settings, thresholdTokens: 60000 }, rates);
  const b = simulate(trace(30), { ...settings, thresholdTokens: 200000 }, rates);
  assert.equal(a.productiveCalls, b.productiveCalls); assert.ok(a.transitions > b.transitions);
});
test("notes pay checkpoint generation, tool round and first note retrieval", () => {
  const r = simulate(trace(20), { ...settings, mode: "history-notes" }, rates);
  for (const k of ["checkpoint_generation", "checkpoint_tool_round", "note_lookup"]) assert.ok(r.costByKind[k] > 0);
  assert.equal(r.costByKind.summary_generation, undefined);
});
test("retrieval adds both model lookup calls and uncached material", () => {
  const base = { ...settings, mode: "history-notes" };
  const a = simulate(trace(20), base, rates);
  const b = simulate(trace(20), { ...base, retrievalTokens: 10000, retrievalCalls: 2 }, rates);
  assert.ok(b.totalCostUSD > a.totalCostUSD); assert.ok(b.costByKind.history_lookup > 0);
  assert.ok(b.cacheWriteTokens > a.cacheWriteTokens);
});
test("comparison baseline may also pay retrieval rather than granting it free recovery", () => {
  const a = simulate(trace(20), settings, rates);
  const b = simulate(trace(20), { ...settings, summaryRetrievalTokens: 10000, summaryRetrievalCalls: 2 }, rates);
  assert.ok(b.totalCostUSD > a.totalCostUSD); assert.ok(b.costByKind.history_lookup > 0);
});
test("cold summary input and loss of static prefix reuse are explicit sensitivities", () => {
  const t = trace(20);
  const a = simulate(t, settings, rates);
  const b = simulate(t, { ...settings, summaryCacheHitFraction: 0, staticReuseFraction: 0 }, rates);
  assert.ok(b.totalCostUSD > a.totalCostUSD);
});
test("invalid candidates are not silently forced into a smaller budget", () => {
  assert.throws(() => simulate(trace(), { ...settings, thresholdTokens: 300000 }, rates));
  assert.throws(() => simulate(trace(), { ...settings, thresholdTokens: 16000 }, rates));
  assert.throws(() => simulate(trace(), { ...settings, typoPrice: 5 }, rates));
  assert.throws(() => simulate(trace(), { ...settings, mode: "history-notes", resumeNoteCalls: 0 }, rates));
  assert.throws(() => simulate(trace(), { ...settings, retrievalTokens: 1000, retrievalCalls: 0 }, rates));
});
test("simulation records candidate failure rather than fabricating a total", () => {
  const r = runSimulation(trace(), { experiments: [{ label: "test", prices: rates, common: {},
    thresholds: [80000, 500000], scenarios: [{ name: "summary", mode: "summary" }] }] });
  assert.ok(!r.results[0].invalid); assert.ok(r.results[1].invalid);
  assert.equal(r.results[1].totalCostUSD, undefined);
});
test("re-pricing a different model trace has a visible caveat", () => {
  const r = runSimulation({ ...trace(), modelKey: "other/model" }, { experiments: [{ label: "test", modelKeys: ["chosen/model"], prices: rates,
    thresholds: [80000], scenarios: [{ name: "summary", mode: "summary" }] }] });
  assert.ok(r.traceWarnings.some(x => x.includes("다른 모델")));
});

const user = (id, parentId = null) => ({ id, parentId, type: "message", message: { role: "user", content: "private user text" }, timestamp: "2026-09-01T00:00:00Z" });
const assistant = (id, parentId, extra = {}) => ({ id, parentId, type: "message", timestamp: "2026-09-01T00:00:01Z", message: {
  role: "assistant", provider: "anthropic", model: "claude-fable-5-1", content: [{ type: "text", text: "private answer" }],
  usage: usage({ input: 1000, cacheRead: 10000, output: 1000 }), ...extra } });
const jsonl = entries => entries.map(e => JSON.stringify(e)).join("\n") + "\n";
const model = "anthropic/claude-fable-5-1";
test("audit sums top usage and nested compaction once, excluding cost.total duplication", () => {
  const a = assistant("a", "u", { usage: { ...usage({ input: 1000, cacheRead: 10000, output: 1000 }),
    compaction: usage({ cacheRead: 10000, output: 500 }), cost: { total: 9999 } } });
  const projection = { id: "p", parentId: "a", type: "compaction", summary: "private summary", details: { source: "anthropic-server-compaction" }, usage: a.message.usage.compaction };
  const r = auditSession(jsonl([user("u"), a, projection]), model, fable);
  near(r.audit.totals.costUSD, .09); assert.equal(r.audit.charges.length, 2);
  assert.equal(r.audit.totals.output, 1500);
  assert.ok(!JSON.stringify(r).includes("private"));
});
test("stored local compaction usage is independently counted", () => {
  const entries = [user("u"), assistant("a", "u"), { id: "c", parentId: "a", type: "compaction", summary: "s", usage: usage({ output: 500 }) }];
  const r = auditSession(jsonl(entries), model, fable);
  assert.equal(r.audit.charges.length, 2); assert.equal(r.audit.totals.output, 1500);
});
test("selected branch never combines sibling-model histories", () => {
  const entries = [user("u"), assistant("a", "u"), assistant("sibling", "u", { model: "different" })];
  const r = auditSession(jsonl(entries), model, fable, "a"); assert.equal(r.trace.calls.length, 1);
  assert.throws(() => auditSession(jsonl(entries), model, fable));
});
test("malformed JSONL, duplicate ids and broken parents stop export", () => {
  assert.throws(() => auditSession("{", model, fable));
  assert.throws(() => auditSession(jsonl([user("x"), user("x")]), model, fable));
  assert.throws(() => auditSession(jsonl([assistant("a", "absent")]), model, fable));
});
test("missing usage stays unknown; estimated output is marked", () => {
  const r = auditSession(jsonl([user("u"), assistant("a", "u", { usage: undefined })]), model, fable);
  assert.equal(r.audit.unknownUsageRecords, 1); assert.equal(r.trace.calls[0].outputSource, "text_estimate");
  assert.ok(r.trace.warnings.includes("missing_usage_is_unknown_not_free"));
});
test("notes-mode management calls are not exported as productive baseline", () => {
  const entries = [user("u"), assistant("a", "u"), { id: "i", parentId: "a", type: "custom", customType: "rubato.context-window.init.v1" }];
  const r = auditSession(jsonl(entries), model, fable);
  assert.equal(r.trace.calls.length, 0); assert.equal(r.audit.charges.length, 1);
});
test("reasoning field is not charged twice on top of reported output", () => {
  const r = auditSession(jsonl([user("u"), assistant("a", "u", { usage: { ...usage({ output: 1000 }), reasoning: 500 } })]), model, fable);
  assert.equal(r.audit.totals.output, 1000);
});
test("raw iterations must be normalized explicitly", () => {
  assert.throws(() => auditSession(jsonl([user("u"), assistant("a", "u", { usage: { ...usage(), iterations: [] } })]), model, fable), /iterations/);
});
test("packaged Astra and Fable grids produce finite conditional results", () => {
  for (const name of ["astra", "fable"]) {
    const config = JSON.parse(readFileSync(new URL(`../../../../docs/context-cost-${name}-scenarios.json`, import.meta.url)));
    const r = runSimulation(trace(100), config);
    assert.ok(r.results.some(x => Number.isFinite(x.totalCostUSD)));
    assert.ok(r.results.every(x => x.invalid || Number.isFinite(x.totalCostUSD)));
  }
});
