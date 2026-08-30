import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeMeasurements, parseMeasurementJsonl } from "../../scripts/analyze-measurements.mjs";

const events = parseMeasurementJsonl(readFileSync(new URL("../fixtures/measurement-events.jsonl", import.meta.url), "utf8"));
const prices = JSON.parse(readFileSync(new URL("../fixtures/measurement-prices.json", import.meta.url), "utf8"));

test("analyzer aggregates call, tool, and task latency", () => {
  const report = analyzeMeasurements(events, { prices });
  assert.equal(report.calls[0].ttftMs, 30);
  assert.equal(report.calls[0].modelDurationMs, 100);
  assert.equal(report.calls[1].interCallWaitMs, 90);
  assert.equal(report.calls[1].tokensPerSecond, 200);
  assert.equal(report.tools[0].executionMs, 50);
  assert.equal(report.tools[0].requestToStartMs, 20);
  assert.match(report.tools[0].phaseSemantics, /execution-start boundary/);
  assert.equal(report.tools[0].postToolToReinsertionMs, 30);
  assert.equal(report.tasks[0].totalDurationMs, 400);
  assert.equal(report.tasks[0].harnessPreModelMs, 10);
  assert.equal(report.tasks[0].modelDurationMs, 220);
  assert.equal(report.tasks[0].interCallWaitMs, 110);
  assert.equal(report.tasks[0].toolExecutionMs, 50);
  assert.equal(report.tasks[0].harnessPostToolMs, 30);
});

test("analyzer aggregates provider cache usage and explicit fixture pricing", () => {
  const report = analyzeMeasurements(events, { prices });
  assert.deepEqual(report.tasks[0].usage, {
    status: "reported",
    inputTokens: 340,
    outputTokens: 28,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    newInputTokens: 240,
    fullInputTokens: 340,
    cacheHitRate: 100 / 340,
  });
  assert.equal(report.calls[1].cost.status, "estimated");
  assert.equal(report.calls[1].cost.source, "deterministic test fixture");
  assert.equal(report.calls[1].cost.savedUsd, 0.00015);
  assert.equal(report.tasks[0].cost.status, "estimated");
});

test("cache diagnosis names measured context candidates without calling unchanged misses eviction", () => {
  const report = analyzeMeasurements(events, { prices });
  assert.equal(report.calls[0].cacheDropCandidates[0].kind, "cold_start");
  assert.deepEqual(report.calls[1].context && {
    category: report.calls[1].context.segments[report.calls[1].context.firstChangedSegment].category,
    segment: report.calls[1].context.firstChangedSegment,
    byte: report.calls[1].context.firstChangedByte,
  }, { category: "tool_results", segment: 1, byte: 0 });
  assert.equal(report.calls[2].cacheDropCandidates[0].kind, "provider_or_unobserved_candidate");
  assert.match(report.calls[2].cacheDropCandidates[0].reason, /routing, eviction, TTL, or unobserved/);
});

test("cost remains unavailable without explicit price source", () => {
  const report = analyzeMeasurements(events);
  assert.equal(report.calls[0].cost.status, "unavailable");
  assert.match(report.calls[0].cost.reason, /no price/);
  assert.equal(report.tasks[0].cost.status, "unavailable");
});

test("tool phases cannot become negative when validation arrives after execution start", () => {
  const report = analyzeMeasurements([
    { sequence: 1, type: "task.input", taskId: "s:1", monotonicMs: 0 },
    { sequence: 2, type: "tool.request", taskId: "s:1", toolCallId: "t", toolName: "read", monotonicMs: 10 },
    { sequence: 3, type: "tool.start", taskId: "s:1", toolCallId: "t", toolName: "read", monotonicMs: 10 },
    { sequence: 4, type: "tool.request_validated", taskId: "s:1", toolCallId: "t", toolName: "read", monotonicMs: 12 },
    { sequence: 5, type: "tool.end", taskId: "s:1", toolCallId: "t", toolName: "read", monotonicMs: 20 },
    { sequence: 6, type: "task.end", taskId: "s:1", monotonicMs: 30 },
  ]);
  assert.equal(report.tools[0].requestToStartMs, 0);
  assert.equal(report.tools[0].executionMs, 10);
});

test("a task with no correlated model call has unavailable usage and cost", () => {
  const report = analyzeMeasurements([
    { sequence: 1, type: "task.input", taskId: "session-1:1", sessionId: "session-1", monotonicMs: 10 },
    { sequence: 2, type: "model.send", taskId: "session-1", sessionId: "session-1", callId: "call-wrong", model: "xai/grok-test", monotonicMs: 20 },
    { sequence: 3, type: "model.end", callId: "call-wrong", durationMs: 5, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, newInputTokens: 0, fullInputTokens: 0 }, monotonicMs: 25 },
    { sequence: 4, type: "task.end", taskId: "session-1:1", sessionId: "session-1", monotonicMs: 30 },
  ], { prices });
  assert.deepEqual(report.tasks[0].callIds, []);
  assert.deepEqual(report.tasks[0].usage, { status: "unavailable", reason: "no model calls correlated to task" });
  assert.deepEqual(report.tasks[0].cost, { status: "unavailable", reason: "no model calls correlated to task" });
});

test("cache diagnosis follows explicit same-model lineage rather than global call order", () => {
  const report = analyzeMeasurements([
    { processId: "p", sequence: 1, type: "model.send", callId: "a", sessionId: "s1", model: "m", provider: "x", monotonicMs: 1, context: {} },
    { processId: "p", sequence: 2, type: "model.end", callId: "a", monotonicMs: 2, usage: { cacheReadTokens: 0 } },
    { processId: "p", sequence: 3, type: "model.send", callId: "noise", sessionId: "s2", model: "m", provider: "x", monotonicMs: 3, context: {} },
    { processId: "p", sequence: 4, type: "model.end", callId: "noise", monotonicMs: 4, usage: { cacheReadTokens: 1 } },
    { processId: "p", sequence: 5, type: "model.send", callId: "b", previousCallId: "a", sessionId: "s1", model: "m", provider: "x", monotonicMs: 5, context: {} },
    { processId: "p", sequence: 6, type: "model.end", callId: "b", monotonicMs: 6, usage: { cacheReadTokens: 0 } },
  ]);
  assert.equal(report.calls.find((call) => call.callId === "b").cacheDropCandidates[0].kind, "provider_or_unobserved_candidate");
});

test("same tool call id in different sessions remains separate", () => {
  const report = analyzeMeasurements([
    { type: "tool.request", sessionId: "s1", taskId: "s1:1", toolCallId: "t", monotonicMs: 1 },
    { type: "tool.start", sessionId: "s1", taskId: "s1:1", toolCallId: "t", monotonicMs: 1 },
    { type: "tool.end", sessionId: "s1", taskId: "s1:1", toolCallId: "t", monotonicMs: 2 },
    { type: "tool.request", sessionId: "s2", taskId: "s2:1", toolCallId: "t", monotonicMs: 10 },
    { type: "tool.start", sessionId: "s2", taskId: "s2:1", toolCallId: "t", monotonicMs: 10 },
    { type: "tool.end", sessionId: "s2", taskId: "s2:1", toolCallId: "t", monotonicMs: 12 },
  ]);
  assert.deepEqual(report.tools.map((tool) => tool.executionMs), [1, 2]);
});

test("correlated calls with no provider usage keep task usage and cost unavailable", () => {
  const report = analyzeMeasurements([
    { type: "task.input", taskId: "s:1", monotonicMs: 0 },
    { type: "model.send", taskId: "s:1", callId: "c", model: "xai/grok-test", monotonicMs: 1 },
    { type: "model.end", callId: "c", monotonicMs: 2 },
    { type: "task.end", taskId: "s:1", monotonicMs: 3 },
  ], { prices });
  assert.equal(report.tasks[0].usage.status, "unavailable");
  assert.equal(report.tasks[0].cost.status, "unavailable");
});

test("cost remains unavailable when full input token count is absent", () => {
  const incomplete = events.map((event) => event.type === "model.end" ? { ...event, usage: { ...event.usage, fullInputTokens: undefined } } : event);
  assert.equal(analyzeMeasurements(incomplete, { prices }).tasks[0].cost.status, "unavailable");
});

test("invalid JSONL reports the exact line", () => {
  assert.throws(() => parseMeasurementJsonl('{}\nnot-json\n'), /line 2/);
});
