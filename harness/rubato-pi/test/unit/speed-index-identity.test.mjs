import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { senpiNested } from "../../src/engine-paths.mjs";
import { CURSOR_GROK_46_DEFAULT_LEVEL, CURSOR_GROK_46_FAST_BY_LEVEL, CURSOR_GROK_46_ID } from "../../src/cursor-grok-fast.mjs";
import { resolvedCursorCallIdentity } from "../../src/cursor-route.mjs";
import { resolveAppliedEffort, resolveCallIdentity } from "../../src/speed-index-identity.mjs";
import { withRubatoStream } from "../../src/rubato-stream.mjs";

const { createAssistantMessageEventStream } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/index.js")).href
);
const { kCursorExecResolved } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/utils/block-symbols.js")).href
);

const map = { off: "none", low: "low", medium: "medium", high: "high" };
const codex = { provider: "openai-codex", id: "gpt-5.6-sol", thinkingLevelMap: map };
const grok = {
  provider: "cursor",
  id: CURSOR_GROK_46_ID,
  thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  compat: { cursorGrokFastByLevel: { ...CURSOR_GROK_46_FAST_BY_LEVEL } },
};
const catalog = Object.values(CURSOR_GROK_46_FAST_BY_LEVEL).map((id) => ({ provider: "cursor", id }));

function scriptedStream(events, { result } = {}) {
  return () => {
    const stream = createAssistantMessageEventStream();
    ;(async () => {
      for (const event of events) stream.push(event);
      stream.end(result);
    })();
    return stream;
  };
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function usage() {
  return { inputTokens: { total: 200, noCache: 200, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 9 } };
}

function memoryStore(classify = () => ({ status: "healthy", source: "probe", rttMs: 8 })) {
  const samples = [];
  return {
    processId: "test-1",
    samples,
    networkHealth: { classify },
    record(sample) { samples.push(sample); return sample; },
  };
}

test("applied effort is call-time reasoning, not a UI label", () => {
  assert.equal(resolveCallIdentity(codex, { reasoning: "high" }).effort, "high");
  assert.equal(resolveCallIdentity(codex, { reasoning: undefined }).effort, "none");
  assert.equal(resolveCallIdentity(codex, {}).effort, "none");
  assert.notEqual(resolveCallIdentity(codex, { reasoning: "high" }).effort, resolveCallIdentity(codex, {}).effort);
});

test("Cursor default and explicit effort report the post-pin variant", () => {
  const def = resolvedCursorCallIdentity(grok, {}, catalog);
  assert.equal(def.identity.effort, CURSOR_GROK_46_DEFAULT_LEVEL);
  assert.equal(def.identity.model, CURSOR_GROK_46_FAST_BY_LEVEL.high);
  assert.equal(def.identity.effortSource, "thinkingSelection");
  const explicit = resolvedCursorCallIdentity(grok, { thinkingSelection: { level: "medium" } }, catalog);
  assert.equal(explicit.identity.effort, "medium");
  assert.equal(explicit.identity.model, CURSOR_GROK_46_FAST_BY_LEVEL.medium);
});

test("outer stream records post-route identity after the Cursor pin callback", async () => {
  const store = memoryStore();
  const message = { role: "assistant", content: [], stopReason: "stop", providerUsage: usage() };
  const inner = (model, context, options) => {
    const { identity } = resolvedCursorCallIdentity(model, options, catalog);
    options.onResolvedCall?.(identity);
    return scriptedStream([
      { type: "text_delta", delta: "hi" },
      { type: "done", reason: "stop", message },
    ])(model, context, options);
  };
  await drain(withRubatoStream(inner)(grok, {
    messages: [],
    tools: [{ name: "read_file", description: "read", parameters: {} }],
  }, {
    env: {},
    speedIndexStore: store,
  }));
  assert.equal(store.samples.length, 1);
  assert.equal(store.samples[0].model, CURSOR_GROK_46_FAST_BY_LEVEL.high);
  assert.equal(store.samples[0].effort, "high");
  assert.equal(store.samples[0].streamKind, "main");
  assert.equal(store.samples[0].terminalStatus, "stop");
  assert.equal(store.samples[0].newInputTokens, 200);
  assert.equal(store.samples[0].exclusion, undefined);
});

test("terminal error/cancel samples are diagnostic-only", async () => {
  const store = memoryStore();
  const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "boom", providerUsage: usage() };
  await drain(withRubatoStream(scriptedStream([
    { type: "error", reason: "error", error: message },
  ]))(codex, { messages: [] }, { env: {}, streamKind: "main", reasoning: "medium", speedIndexStore: store }));
  assert.equal(store.samples[0].terminalStatus, "error");
  assert.equal(store.samples[0].exclusion, undefined);
  const cancelled = memoryStore();
  const inner = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const stream = withRubatoStream(inner)(codex, { messages: [] }, { env: {}, streamKind: "main", reasoning: "medium", speedIndexStore: cancelled });
  await stream[Symbol.asyncIterator]().return();
  assert.equal(cancelled.samples[0].terminalStatus, "cancelled");
});

test("auxiliary streamKind is excluded; Cursor exec-resolved is diagnostic-only", async () => {
  const aux = memoryStore();
  const message = { role: "assistant", content: [], stopReason: "stop", providerUsage: usage() };
  await drain(withRubatoStream(scriptedStream([
    { type: "done", reason: "stop", message },
  ]))(codex, { messages: [] }, { env: {}, reasoning: "medium", speedIndexStore: aux }));
  assert.equal(aux.samples[0].exclusion, "auxiliary_stream");
  assert.equal(aux.samples[0].streamKind, "auxiliary");

  const execStore = memoryStore();
  const execMessage = {
    role: "assistant",
    stopReason: "stop",
    providerUsage: usage(),
    content: [{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "/a" }, [kCursorExecResolved]: true }],
  };
  await drain(withRubatoStream(scriptedStream([
    { type: "done", reason: "stop", message: execMessage },
  ]))(grok, { messages: [] }, { env: {}, streamKind: "main", speedIndexStore: execStore }));
  assert.equal(execStore.samples[0].exclusion, "cursor_exec_resolved");
});


test("thinkingLevelMap remaps requested effort; unsupported off:null is unknown", () => {
  const remapped = { provider: "xai", id: "grok-4.6", thinkingLevelMap: { off: "none", high: "xhigh" } };
  const mapped = resolveAppliedEffort(remapped, { reasoning: "high" });
  assert.equal(mapped.effort, "xhigh");
  assert.equal(mapped.source, "thinkingLevelMap");
  const offNone = resolveAppliedEffort(remapped, {});
  assert.equal(offNone.effort, "none");
  assert.equal(offNone.source, "thinkingLevelMap");
  const noOff = { provider: "cursor", id: CURSOR_GROK_46_ID, thinkingLevelMap: { off: null, high: "high" } };
  assert.equal(resolveAppliedEffort(noOff, { reasoning: "off" }).source, "unknown");
  assert.equal(resolveAppliedEffort(noOff, {}).source, "unknown");
  assert.equal(resolveAppliedEffort(noOff, {}).effort, undefined);
  const unmapped = { provider: "xai", id: "g" };
  assert.equal(resolveAppliedEffort(unmapped, { reasoning: "high" }).source, "options.reasoning");
  assert.equal(resolveAppliedEffort(unmapped, { reasoning: "high" }).effort, "high");
  assert.equal(resolveAppliedEffort(unmapped, { reasoning: "weird" }).source, "unknown");
});

test("post-Cursor pin reports thinkingSelection, not a map guess", () => {
  const pinned = resolveAppliedEffort(grok, { thinkingSelection: { level: "medium" } });
  assert.equal(pinned.effort, "medium");
  assert.equal(pinned.source, "thinkingSelection");
  const identity = resolveCallIdentity(grok, { thinkingSelection: { level: "medium", legacyVariantId: CURSOR_GROK_46_FAST_BY_LEVEL.medium } });
  assert.equal(identity.model, CURSOR_GROK_46_FAST_BY_LEVEL.medium);
  assert.equal(identity.effortSource, "thinkingSelection");
});
