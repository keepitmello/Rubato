import assert from "node:assert/strict";
import test from "node:test";
import { contextChange, contextSegments, createMeasurementRecorder, firstChangedSegment, installMeasurementHooks, normalizeProviderUsage } from "../../src/measurement-recorder.mjs";

function recorderFixture() {
  const lines = [];
  let monotonicMs = 100;
  const recorder = createMeasurementRecorder({
    env: { RUBATO_MEASUREMENT_LOG: "/tmp/not-written.jsonl" },
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    monotonic: () => monotonicMs,
    append: (_path, line) => lines.push(JSON.parse(line)),
  });
  return { recorder, lines, tick: (ms) => { monotonicMs += ms; } };
}

test("provider usage preserves unavailable fields and reported zero", () => {
  assert.equal(normalizeProviderUsage(undefined), undefined);
  assert.deepEqual(normalizeProviderUsage({ inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0 } }), {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    newInputTokens: 0,
    outputTokens: 0,
    fullInputTokens: 0,
  });
  assert.deepEqual(normalizeProviderUsage({ inputTokens: { total: 100, cacheRead: 60, cacheWrite: 10 }, outputTokens: { total: 5 } }), {
    inputTokens: 100,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    newInputTokens: 30,
    outputTokens: 5,
    fullInputTokens: 100,
    cacheHitRate: 0.6,
  });
});

test("call events carry TTFT, byte-level context diffs, and inter-call wait", () => {
  const fx = recorderFixture();
  const first = fx.recorder.startCall({ taskId: "task-1", sessionId: "session-1", provider: "xai", model: "xai/grok", body: { prompt: [{ role: "user", content: "one" }] } });
  fx.tick(25);
  fx.recorder.firstOutput(first.callId, { outputType: "text_delta" });
  fx.tick(75);
  fx.recorder.endCall(first.callId, { status: "stop" });
  fx.tick(20);
  const second = fx.recorder.startCall({ taskId: "task-1", sessionId: "session-1", provider: "xai", model: "xai/grok", body: { prompt: [{ role: "user", content: "one" }, { role: "tool", content: [] }] } });
  assert.equal(typeof fx.lines[0].attemptId, "string");
  assert.equal(fx.lines[1].ttftMs, 25);
  assert.equal(fx.lines[2].durationMs, 100);
  assert.equal(fx.lines[3].context.firstChangedSegment, 1);
  assert.equal(fx.lines[3].context.firstChangedByte, 0);
  assert.equal(fx.lines[3].previousCallId, first.callId);
  assert.equal(fx.lines[3].interCallWaitMs, 20);
  assert.notEqual(first.callId, second.callId);
  assert.equal(firstChangedSegment([{ category: "conversation", digest: "a" }], [{ category: "conversation", digest: "a" }]), undefined);
});

test("logical context categories expose provenance and UTF-8 changed byte", () => {
  const before = contextSegments({ prompt: [
    { role: "system", content: "base" },
    { role: "system", content: "<!-- senpi-memory:agent:begin -->memo" },
    { role: "system", content: "AGENTS.md project rules" },
    { role: "user", content: "héllo" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1" }] },
    { role: "mystery", content: "x" },
  ], tools: [{ name: "read" }] });
  assert.deepEqual(before.map(({ category, provenance, source }) => ({ category, provenance, source })), [
    { category: "harness_base", provenance: "position", source: "system_prompt" },
    { category: "memory", provenance: "marker", source: "system_prompt" },
    { category: "project_fixed_context", provenance: "marker", source: "system_prompt" },
    { category: "conversation", provenance: "role", source: "conversation_message" },
    { category: "tool_results", provenance: "role", source: "conversation_message" },
    { category: "unknown", provenance: "unknown", source: "prompt_item" },
    { category: "harness_base", provenance: "wire_field", source: "tool_definitions" },
  ]);
  const after = contextSegments({ prompt: [{ role: "user", content: "héXlo" }] });
  const one = contextSegments({ prompt: [{ role: "user", content: "héllo" }] });
  const changed = contextChange(one, after);
  assert.equal(changed.segment, 0);
  assert.equal(changed.byte, Buffer.byteLength('{"role":"user","content":"hé'));
});

test("tool result first reinsertion is distinct from repeated historical presence", () => {
  const fx = recorderFixture();
  fx.recorder.observeToolReinsertion({ sessionId: "s1", taskId: "task-1", callId: "model-1", toolCallId: "tool-1" });
  fx.recorder.observeToolReinsertion({ sessionId: "s1", taskId: "task-1", callId: "model-2", toolCallId: "tool-1" });
  fx.recorder.observeToolReinsertion({ sessionId: "s1", taskId: "task-1", callId: "model-2", toolCallId: "tool-2" });
  assert.deepEqual(fx.lines.map(({ type, presence }) => ({ type, presence })), [
    { type: "tool.result_reinserted", presence: "first_reinsertion" },
    { type: "tool.result_present", presence: "repeated" },
    { type: "tool.result_reinserted", presence: "first_reinsertion" },
  ]);
});

test("active task bridges session-scoped model calls to colon-suffixed input ids", async () => {
  const fx = recorderFixture();
  const handlers = new Map();
  installMeasurementHooks({ on: (name, handler) => handlers.set(name, handler) }, { recorder: fx.recorder });
  const ctx = { sessionManager: { getSessionId: () => "session-1" } };
  await handlers.get("input")({ type: "input", inputId: "session-1:1", text: "run", source: "rpc" }, ctx);
  const call = fx.recorder.startCall({ sessionId: "session-1", provider: "xai", model: "xai/grok", body: { prompt: [] } });
  assert.equal(call.event.taskId, "session-1:1");
  assert.equal(fx.recorder.activeTaskId("session-1"), "session-1:1");
  fx.recorder.endCall(call.callId, { status: "stop" });
  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);
  assert.equal(fx.recorder.activeTaskId("session-1"), undefined);
});

test("task and tool hooks produce derivable task lifecycle without raw input", async () => {
  const fx = recorderFixture();
  const handlers = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler) };
  installMeasurementHooks(pi, { recorder: fx.recorder });
  const ctx = { sessionManager: { getSessionId: () => "session-1" } };
  await handlers.get("input")({ type: "input", inputId: "task-1", text: "secret", source: "interactive" }, ctx);
  await handlers.get("tool_execution_start")({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" }, ctx);
  await handlers.get("tool_call")({ type: "tool_call", toolCallId: "call-1", toolName: "read", input: { path: "/private/file" } }, ctx);
  await handlers.get("tool_execution_end")({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false }, ctx);
  fx.tick(50);
  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);
  assert.deepEqual(fx.lines.map((event) => event.type), ["task.input", "tool.request", "tool.start", "tool.request_validated", "tool.end", "task.end"]);
  assert.equal(fx.lines[0].inputBytes, 6);
  assert.equal(JSON.stringify(fx.lines).includes("secret"), false);
  assert.equal(fx.lines.at(-1).durationMs, 50);
  assert.equal(fx.lines[1].monotonicMs, fx.lines[2].monotonicMs);
});

test("pending model calls record an instrumentation error and close task incomplete without throwing", async () => {
  const fx = recorderFixture();
  const handlers = new Map();
  installMeasurementHooks({ on: (name, handler) => handlers.set(name, handler) }, { recorder: fx.recorder });
  const ctx = { sessionManager: { getSessionId: () => "session-race" } };
  await handlers.get("input")({ type: "input", inputId: "session-race:1", text: "run", source: "rpc" }, ctx);
  const call = fx.recorder.startCall({ sessionId: "session-race", provider: "xai", model: "xai/grok", body: { prompt: [] } });
  assert.doesNotThrow(() => handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx));
  assert.deepEqual(fx.lines.slice(-2).map((event) => event.type), ["instrumentation.error", "task.end"]);
  assert.equal(fx.lines.at(-1).status, "incomplete");
  assert.equal(fx.lines.at(-1).incompleteReason, "pending_model_calls");
  fx.recorder.endCall(call.callId, { status: "stop" });
});

test("lineage is scoped by session and model while unscoped calls remain independent", () => {
  const fx = recorderFixture();
  const first = fx.recorder.startCall({ sessionId: "s", provider: "xai", model: "m1", body: { prompt: [] } });
  fx.recorder.endCall(first.callId);
  const otherModel = fx.recorder.startCall({ sessionId: "s", provider: "xai", model: "m2", body: { prompt: [] } });
  const otherSession = fx.recorder.startCall({ sessionId: "s2", provider: "xai", model: "m1", body: { prompt: [] } });
  const unscoped1 = fx.recorder.startCall({ provider: "xai", model: "m1", body: { prompt: [] } });
  const unscoped2 = fx.recorder.startCall({ provider: "xai", model: "m1", body: { prompt: [] } });
  for (const call of [otherModel, otherSession, unscoped1, unscoped2]) assert.equal(call.event.previousCallId, undefined);
  assert.equal(unscoped2.event.context.firstChangedSegment, undefined);
});

test("raw context capture requires explicit opt-in and every record carries process identity", () => {
  const writes = [];
  const lines = [];
  const recorder = createMeasurementRecorder({
    env: { RUBATO_MEASUREMENT_LOG: "/tmp/log", RUBATO_MEASUREMENT_RAW_DIR: "/tmp/raw", RUBATO_MEASUREMENT_PROCESS_ID: "process-test" },
    append: (_path, line) => lines.push(JSON.parse(line)),
  });
  const call = recorder.startCall({ sessionId: "s", provider: "xai", model: "m", body: { prompt: [] } });
  assert.equal(call.event.processId, "process-test");
  assert.equal(call.event.context.rawContextPath, undefined);
  assert.deepEqual(writes, []);
});
