import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { senpiNested } from "../../src/engine-paths.mjs";
import {
  createCodexReasoningReplay,
  FAILURES_BEFORE_SEARCH,
} from "../../src/codex-reasoning-replay.mjs";
import { withRubatoStream } from "../../src/rubato-stream.mjs";

const { createAssistantMessageEventStream } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/index.js")).href
);

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
const SERVER_ERROR = "Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 006d190e in your message.";

function turn(n) {
  return {
    role: "assistant",
    api: codex.api,
    provider: codex.provider,
    model: codex.id,
    timestamp: n,
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: JSON.stringify({ type: "reasoning", id: `rs_${n}`, encrypted_content: "gAAAA" }) },
      { type: "toolCall", id: `call_${n}`, name: "read", arguments: { path: "a.md" } },
    ],
  };
}

function context(...ns) {
  return { messages: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }, ...ns.map(turn)] };
}

const failed = { role: "assistant", stopReason: "error", errorMessage: SERVER_ERROR, content: [] };
const ok = { role: "assistant", stopReason: "toolUse", content: [] };

/** Reasoning ids the request actually carries. */
const sentIds = (ctx) => ctx.messages.flatMap((m) => (m.role === "assistant" ? m.content : []))
  .filter((block) => block.type === "thinking").map((block) => JSON.parse(block.thinkingSignature).id);

/** A fake server that fails whenever the request carries one of `poisoned`. */
function serve(replay, ctx, poisoned) {
  const sent = replay.prepare(codex, ctx, "s1");
  const result = sentIds(sent).some((id) => poisoned.includes(id)) ? failed : ok;
  replay.observe(codex, ctx, "s1", result);
  return { sent: sentIds(sent), result };
}

test("normally every reasoning item is sent, like the Codex CLI", () => {
  const replay = createCodexReasoningReplay();
  const ctx = context(1, 2, 3);
  replay.observe(codex, ctx, "s1", failed);
  assert.equal(replay.prepare(codex, ctx, "s1"), ctx, "one failure can be transient");
});

test("consecutive failures drop only the poisoned item, found newest first", () => {
  const replay = createCodexReasoningReplay();
  const ctx = context(1, 2, 3, 4);
  const attempts = [];
  for (let i = 0; i < 6; i += 1) attempts.push(serve(replay, ctx, ["rs_2"]));

  assert.deepEqual(attempts.map((a) => a.sent), [
    ["rs_1", "rs_2", "rs_3", "rs_4"],
    ["rs_1", "rs_2", "rs_3", "rs_4"],
    ["rs_1", "rs_2", "rs_3"],
    ["rs_1", "rs_2", "rs_4"],
    ["rs_1", "rs_3", "rs_4"],
    ["rs_1", "rs_3", "rs_4"],
  ]);
  assert.deepEqual(attempts.map((a) => a.result.stopReason), ["error", "error", "error", "error", "toolUse", "toolUse"]);

  const later = replay.prepare(codex, context(1, 2, 3, 4, 5), "s1");
  assert.deepEqual(sentIds(later), ["rs_1", "rs_3", "rs_4", "rs_5"], "new reasoning is sent again");
});

test("when no single item helps, everything sent so far is dropped so the session goes on", () => {
  const replay = createCodexReasoningReplay();
  const ctx = context(1, 2);
  const attempts = [];
  for (let i = 0; i < 6; i += 1) attempts.push(serve(replay, ctx, ["rs_1", "rs_2"]));
  assert.equal(attempts.at(-1).result.stopReason, "toolUse");
  assert.deepEqual(sentIds(replay.prepare(codex, context(1, 2, 3), "s1")), ["rs_3"]);
});

test("other errors, other sessions and other providers are left alone", () => {
  const replay = createCodexReasoningReplay();
  const ctx = context(1, 2);
  for (let i = 0; i < FAILURES_BEFORE_SEARCH + 2; i += 1) {
    replay.observe(codex, ctx, "s1", { ...failed, errorMessage: "WebSocket closed 1000" });
    replay.observe({ ...codex, api: "anthropic-messages" }, ctx, "s1", failed);
  }
  assert.equal(replay.prepare(codex, ctx, "s1"), ctx);

  for (let i = 0; i < FAILURES_BEFORE_SEARCH; i += 1) replay.observe(codex, ctx, "s2", failed);
  assert.equal(replay.prepare(codex, ctx, "s1"), ctx, "another session keeps its reasoning");
  assert.equal(replay.prepare({ ...codex, api: "anthropic-messages" }, ctx, "s2"), ctx);
});

test("the found item is remembered across an engine restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-reasoning-replay-"));
  try {
    const before = createCodexReasoningReplay({ dir });
    const ctx = context(1, 2);
    for (let i = 0; i < 4; i += 1) serve(before, ctx, ["rs_2"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "s1.json"), "utf8")), { dropped: ["rs_2"] });

    const after = createCodexReasoningReplay({ dir });
    assert.deepEqual(sentIds(after.prepare(codex, ctx, "s1")), ["rs_1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("through the stream decorator, the retry after consecutive server errors leaves out the newest reasoning", async () => {
  const replay = createCodexReasoningReplay();
  const received = [];
  const results = [failed, failed, ok];
  const inner = (_model, ctx) => {
    received.push(sentIds(ctx));
    const message = { ...results[received.length - 1], timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push(message.stopReason === "error"
        ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
  const decorated = withRubatoStream(inner);

  for (let i = 0; i < results.length; i += 1) {
    const stream = decorated(codex, context(1, 2), { sessionId: "s1", codexReasoningReplay: replay });
    for await (const _event of stream) { /* drain */ }
    await stream.result();
  }

  assert.deepEqual(received, [["rs_1", "rs_2"], ["rs_1", "rs_2"], ["rs_1"]]);
});
