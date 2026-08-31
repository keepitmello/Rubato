import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAssistantMessage,
  explicitTextPhase,
  fallbackTextPhase,
  normalizeProviderPhase,
  parseTextSignature,
  phaseForTextContent,
  segmentAssistantText,
} from "../../src/transforms/assistant-phase.mjs";

const commentary = JSON.stringify({ v: 1, id: "c1", phase: "commentary" });
const finalAnswer = JSON.stringify({ v: 1, id: "f1", phase: "final_answer" });

test("explicit provider phases normalize to progress and final", () => {
  assert.equal(normalizeProviderPhase("commentary"), "progress");
  assert.equal(normalizeProviderPhase("final_answer"), "final");
  assert.equal(parseTextSignature("plain-id"), undefined);
  assert.equal(explicitTextPhase({ textSignature: commentary }), "progress");
  assert.equal(explicitTextPhase({ textSignature: finalAnswer }), "final");
});

test("mixed blocks in one message stay as separate segments", () => {
  const message = {
    id: "asst-1",
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "text", text: "looking", textSignature: commentary },
      { type: "text", text: " still", textSignature: commentary },
      { type: "text", text: "done", textSignature: finalAnswer },
    ],
  };
  const segments = segmentAssistantText(message);
  assert.deepEqual(segments.map((item) => [item.id, item.phase, item.text]), [
    ["asst-1:text:0", "progress", "looking still"],
    ["asst-1:text:1", "final", "done"],
  ]);
});

test("fallback: text plus toolCall is progress", () => {
  const message = {
    id: "asst-2",
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "text", text: "calling grep" },
      { type: "toolCall", id: "t1", name: "grep" },
    ],
  };
  assert.equal(fallbackTextPhase(message), "progress");
  assert.equal(phaseForTextContent(message.content[0], message), "progress");
});

test("fallback: last text-only stop is a final candidate; abort/error are not", () => {
  assert.equal(fallbackTextPhase({
    stopReason: "stop",
    content: [{ type: "text", text: "here is the answer" }],
  }), "final");
  assert.equal(fallbackTextPhase({
    stopReason: "aborted",
    content: [{ type: "text", text: "partial" }],
  }), undefined);
  assert.equal(fallbackTextPhase({
    stopReason: "error",
    content: [{ type: "text", text: "boom" }],
  }), undefined);
});

test("classifyAssistantMessage reports tools and segments", () => {
  const classified = classifyAssistantMessage({
    id: "asst-3",
    stopReason: "toolUse",
    content: [
      { type: "text", text: "working" },
      { type: "toolCall", id: "t1", name: "read" },
    ],
  });
  assert.equal(classified.hasToolCalls, true);
  assert.equal(classified.segments[0].phase, "progress");
});
