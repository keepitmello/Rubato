import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { pathToFileURL } from "node:url";
import {
  CONTEXT_PIPELINE_NEEDLE,
  PRUNE_TO_BUDGET_NEEDLE,
  injectCompactionContextPipeline,
  injectCompactionOverflowRetry,
  isCompactionContextPipelineUrl,
  isCompactionOverflowRetryUrl,
} from "../../src/transforms/core-compaction-prune.mjs";

function pinned(rel) {
  return readFileSync(join(senpiDir, rel), "utf8");
}

test("핀된 context-pipeline.js 에 Cursor thinking 제거 패치가 바르게 적용된다", () => {
  const source = pinned("dist/core/extensions/builtin/compaction/context-pipeline.js");
  assert.equal(source.includes(CONTEXT_PIPELINE_NEEDLE), true, "CONTEXT_PIPELINE_NEEDLE present");
  const next = injectCompactionContextPipeline(source);
  assert.match(next, /stripCursorThinking/);
  assert.match(next, /input\.ctx\?\.model\?\.provider === "cursor"/);
  assert.throws(() => injectCompactionContextPipeline(next), /drift/);
  assert.equal(
    isCompactionContextPipelineUrl("file:///x/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/context-pipeline.js"),
    true,
  );
});

test("핀된 overflow-retry.js 의 pruneOldMessagesToBudget 이 O(N) 구현으로 교체된다", () => {
  const source = pinned("dist/core/extensions/builtin/compaction/overflow-retry.js");
  assert.equal(source.includes(PRUNE_TO_BUDGET_NEEDLE), true, "PRUNE_TO_BUDGET_NEEDLE present");
  const next = injectCompactionOverflowRetry(source);
  assert.match(next, /tokenMap = new Array\(messages\.length\)/);
  assert.match(next, /toRemove = new Set\(\)/);
  assert.throws(() => injectCompactionOverflowRetry(next), /drift/);
  assert.equal(
    isCompactionOverflowRetryUrl("file:///x/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/overflow-retry.js"),
    true,
  );
});

test("pruneOldMessagesToBudget O(N) 은 도구 쌍을 원자적으로 제거하고 대용량에서도 즉시 수렴한다", async () => {
  // overflow-retry.js 소스에 주입 후 동적으로 모듈 import
  const source = pinned("dist/core/extensions/builtin/compaction/overflow-retry.js");
  const transformed = injectCompactionOverflowRetry(source);

  const absCompactionUrl = pathToFileURL(join(senpiDir, "dist/core/compaction/index.js")).href;
  const modSource = transformed.replace('../../../compaction/index.js', absCompactionUrl);
  const dataUri = `data:text/javascript;base64,${Buffer.from(modSource).toString("base64")}`;
  const { pruneOldMessagesToBudget, estimateTotalTokens } = await import(dataUri);

  // 100개 턴의 긴 히스토리 생성 (도구 호출 + 도구 결과 쌍 다수)
  const messages = [];
  for (let i = 0; i < 50; i++) {
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
  // 마지막 사용자 지시
  messages.push({
    role: "user",
    content: [{ type: "text", text: "Final user instruction" }],
  });

  const totalTokens = estimateTotalTokens(messages);
  assert.equal(totalTokens > 1000, true);

  const t0 = performance.now();
  // 절반 예산으로 프루닝
  const targetTokens = Math.floor(totalTokens / 2);
  const pruned = pruneOldMessagesToBudget(messages, targetTokens);
  const elapsedMs = performance.now() - t0;

  // O(N)이라 50ms 이내에 완료되어야 함 (기존 O(N^2)는 수 초 소요)
  assert.equal(elapsedMs < 100, true, `pruning took ${elapsedMs}ms, expected < 100ms`);

  // 예산 이내로 줄었는지 확인
  const prunedTokens = estimateTotalTokens(pruned);
  assert.equal(prunedTokens <= targetTokens, true);

  // 마지막 유저 메시지는 반드시 보존되어야 함
  const lastMsg = pruned.at(-1);
  assert.equal(lastMsg.role, "user");
  assert.equal(lastMsg.content[0].text, "Final user instruction");

  // 남아있는 toolResult는 반드시 짝이 맞는 assistant toolCall이 있어야 함 (고아 제거 검증)
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
