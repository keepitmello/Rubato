import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { senpiDir } from "../../src/engine-paths.mjs";
import {
  CONTEXT_PIPELINE_NEEDLE,
  EMERGENCY_PRUNE_WINDOW_NEEDLE,
  ESTIMATE_WIRE_TOKENS_NEEDLE,
  PRUNE_TO_BUDGET_NEEDLE,
  injectCompactionContextPipeline,
  injectCompactionOverflowRetry,
  isCompactionContextPipelineUrl,
  isCompactionOverflowRetryUrl,
} from "../../src/transforms/core-compaction-prune.mjs";

function pinned(rel) {
  return readFileSync(join(senpiDir, rel), "utf8");
}

test("핀된 context-pipeline.js 에 Cursor thinking 제거 및 긴급 컴팩션 윈도우 정상화 패치가 바르게 적용된다", () => {
  const source = pinned("dist/core/extensions/builtin/compaction/context-pipeline.js");
  assert.equal(source.includes(CONTEXT_PIPELINE_NEEDLE), true, "CONTEXT_PIPELINE_NEEDLE present");
  assert.equal(source.includes(EMERGENCY_PRUNE_WINDOW_NEEDLE), true, "EMERGENCY_PRUNE_WINDOW_NEEDLE present");
  const next = injectCompactionContextPipeline(source);
  assert.match(next, /stripCursorThinking/);
  assert.match(next, /input\.ctx\?\.model\?\.provider === "cursor"/);
  assert.match(next, /hardLimitEmergencyPrune\(sourceMessages, input\.contextWindow, input\.emergencyPruneLatch\)/);
  assert.throws(() => injectCompactionContextPipeline(next), /drift/);
  assert.equal(
    isCompactionContextPipelineUrl("file:///x/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/context-pipeline.js"),
    true,
  );
});

test("핀된 overflow-retry.js 에 estimateWireTokens sanitize 및 O(N) 프루너가 바르게 적용된다", () => {
  const source = pinned("dist/core/extensions/builtin/compaction/overflow-retry.js");
  assert.equal(source.includes(ESTIMATE_WIRE_TOKENS_NEEDLE), true, "ESTIMATE_WIRE_TOKENS_NEEDLE present");
  assert.equal(source.includes(PRUNE_TO_BUDGET_NEEDLE), true, "PRUNE_TO_BUDGET_NEEDLE present");
  const next = injectCompactionOverflowRetry(source);
  assert.match(next, /sanitizeForWireEstimate/);
  assert.match(next, /visitedCallIds/);
  assert.throws(() => injectCompactionOverflowRetry(next), /drift/);
  assert.equal(
    isCompactionOverflowRetryUrl("file:///x/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/overflow-retry.js"),
    true,
  );
});

test("estimateWireTokens 는 어시스턴트의 거대 thinking 블록을 와이어 토큰 추정에서 제외한다", async () => {
  const source = pinned("dist/core/extensions/builtin/compaction/overflow-retry.js");
  const transformed = injectCompactionOverflowRetry(source);

  const absCompactionUrl = pathToFileURL(join(senpiDir, "dist/core/compaction/index.js")).href;
  const modSource = transformed.replace('../../../compaction/index.js', absCompactionUrl);
  const dataUri = `data:text/javascript;base64,${Buffer.from(modSource).toString("base64")}`;
  const { estimateTotalTokens } = await import(dataUri);

  const hugeThinkingMsg = {
    role: "assistant",
    content: [
      { type: "text", text: "Hello world" },
      { type: "thinking", thinking: "Deep thought ".repeat(5000) }, // 65,000 자 thinking
    ],
  };

  const estimated = estimateTotalTokens([hugeThinkingMsg]);
  // thinking이 제외되었으므로 수만 토큰이 아니라 "Hello world"의 수십 토큰 수준이어야 함
  assert.equal(estimated < 100, true, `estimated tokens: ${estimated}, expected < 100`);
});

test("pruneOldMessagesToBudget O(N) 은 도구 쌍을 원자적으로 제거하고 대용량에서도 즉시 수렴한다", async () => {
  const source = pinned("dist/core/extensions/builtin/compaction/overflow-retry.js");
  const transformed = injectCompactionOverflowRetry(source);

  const absCompactionUrl = pathToFileURL(join(senpiDir, "dist/core/compaction/index.js")).href;
  const modSource = transformed.replace('../../../compaction/index.js', absCompactionUrl);
  const dataUri = `data:text/javascript;base64,${Buffer.from(modSource).toString("base64")}`;
  const { pruneOldMessagesToBudget, estimateTotalTokens } = await import(dataUri);

  // 200개 턴의 긴 히스토리 생성 (100쌍의 도구 호출 + 결과)
  const messages = [];
  for (let i = 0; i < 100; i++) {
    const callId = `call_${i}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Assistant turn ${i}` },
        { type: "toolCall", id: callId, name: "read_file", arguments: { path: `file_${i}.txt` } },
      ],
    });
    messages.push({
      role: "toolResult",
      toolCallId: callId,
      content: [{ type: "text", text: `File content ${i}: ${"x".repeat(100)}` }],
    });
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: "Final user instruction" }],
  });

  const totalTokens = estimateTotalTokens(messages);
  const targetTokens = Math.floor(totalTokens / 2);

  const t0 = performance.now();
  const pruned = pruneOldMessagesToBudget(messages, targetTokens);
  const elapsedMs = performance.now() - t0;

  assert.equal(elapsedMs < 100, true, `pruning took ${elapsedMs}ms, expected < 100ms`);
  assert.equal(estimateTotalTokens(pruned) <= targetTokens, true);

  const lastMsg = pruned.at(-1);
  assert.equal(lastMsg.role, "user");
  assert.equal(lastMsg.content[0].text, "Final user instruction");

  const retainedCallIds = new Set();
  for (const m of pruned) {
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "toolCall") retainedCallIds.add(b.id);
      }
    }
  }
  for (const m of pruned) {
    if (m.role === "toolResult") {
      assert.equal(retainedCallIds.has(m.toolCallId), true, `toolResult ${m.toolCallId} was orphaned`);
    }
  }
});

test("pruneOldMessagesToBudget O(N) 은 중복 toolCall ID 가 있어도 O(N^2) 회귀 없이 안전하게 처리한다", async () => {
  const source = pinned("dist/core/extensions/builtin/compaction/overflow-retry.js");
  const transformed = injectCompactionOverflowRetry(source);

  const absCompactionUrl = pathToFileURL(join(senpiDir, "dist/core/compaction/index.js")).href;
  const modSource = transformed.replace('../../../compaction/index.js', absCompactionUrl);
  const dataUri = `data:text/javascript;base64,${Buffer.from(modSource).toString("base64")}`;
  const { pruneOldMessagesToBudget, estimateTotalTokens } = await import(dataUri);

  // 모든 assistant 가 동일한 ID("dup_call")를 공유하는 악성/손상 케이스
  const messages = [];
  for (let i = 0; i < 50; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Assistant turn ${i}` },
        { type: "toolCall", id: "dup_call", name: "ping", arguments: {} },
      ],
    });
    messages.push({
      role: "toolResult",
      toolCallId: "dup_call",
      content: [{ type: "text", text: `Pong ${i}` }],
    });
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: "Boundary user" }],
  });

  const totalTokens = estimateTotalTokens(messages);
  const t0 = performance.now();
  const pruned = pruneOldMessagesToBudget(messages, Math.floor(totalTokens / 2));
  const elapsedMs = performance.now() - t0;

  assert.equal(elapsedMs < 50, true, `duplicate callId pruning took ${elapsedMs}ms, expected < 50ms`);
  assert.equal(pruned.length < messages.length, true);
});
