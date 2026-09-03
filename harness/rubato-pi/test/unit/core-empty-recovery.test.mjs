// 버퍼링된 thinking 접두가 stream-start 감시에 "살아 있음" 으로 보이는지.
//
// pi-agent-core 의 `withEmptyAssistantRecovery` 는 Claude 모델의 `start`·`thinking_delta`
// 를 보이는 내용이 나올 때까지 쥔다. 변환 전에는 그동안 agent-loop 의 start 감시가
// 첫 event 를 못 보고 `Provider stream start timed out` 으로 끊었다. 여기서는 실제
// agent loop 를 돌려, thinking 만 start 예산의 세 배 동안 흘러도 살아남고 정말 죽은
// 상류는 여전히 예산 안에 끊기는지를 본다. 변환은 `--import no-changelog-register` 로 걸린다.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiNested } from "../../src/engine-paths.mjs";
import { injectEmptyRecoveryLiveness } from "../../src/transforms/core-empty-recovery.mjs";

const agentCore = await import(pathToFileURL(senpiNested("@earendil-works/pi-agent-core/dist/agent-loop.js")).href);
const piAi = await import(pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/index.js")).href);

const START_TIMEOUT_MS = 200;
const model = { id: "claude-test", provider: "anthropic", api: "anthropic-messages" };

function baseMessage() {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** stream: thinking 만 `thinkingMs` 동안, 그 뒤 text 하나와 done. */
function thinkingThenTextStreamFn({ thinkingMs }) {
  return (_model, _context, options) => {
    const stream = piAi.createAssistantMessageEventStream();
    void (async () => {
      const partial = baseMessage();
      stream.push({ type: "start", partial });
      const startedAt = Date.now();
      let index = 0;
      partial.content.push({ type: "thinking", thinking: "" });
      stream.push({ type: "thinking_start", contentIndex: 0, partial });
      while (Date.now() - startedAt < thinkingMs) {
        if (options?.signal?.aborted) return;
        partial.content[0].thinking += "…";
        stream.push({ type: "thinking_delta", contentIndex: 0, delta: "…", partial });
        index += 1;
        await sleep(40);
      }
      stream.push({ type: "thinking_end", contentIndex: 0, content: partial.content[0].thinking, partial });
      partial.content.push({ type: "text", text: "done" });
      stream.push({ type: "text_start", contentIndex: 1, partial });
      stream.push({ type: "text_delta", contentIndex: 1, delta: "done", partial });
      stream.push({ type: "text_end", contentIndex: 1, content: "done", partial });
      const message = { ...partial, stopReason: "stop" };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      assert.ok(index > 0);
    })();
    return stream;
  };
}

/** stream: 영원히 아무것도 안 온다. */
function deadStreamFn() {
  return () => piAi.createAssistantMessageEventStream();
}

async function runOnce(streamFn) {
  const context = { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] };
  const config = {
    model,
    convertToLlm: async (messages) => messages,
    streamStartTimeoutMs: START_TIMEOUT_MS,
    timeoutMs: 10_000,
  };
  const messages = await agentCore.runAgentLoopContinue(context, config, async () => {}, undefined, streamFn);
  return messages.at(-1);
}

test("transform rewrites every needle on the installed pi-agent-core", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(senpiNested("@earendil-works/pi-agent-core/dist/empty-assistant-recovery.js"), "utf8");
  const next = injectEmptyRecoveryLiveness(source);
  assert.notEqual(next, source);
  assert.match(next, /outerStream\.hasPendingLocalWork = \(\) =>/);
});

test("thinking-only prefix three times the start budget survives", async () => {
  const last = await runOnce(thinkingThenTextStreamFn({ thinkingMs: START_TIMEOUT_MS * 3 }));
  assert.equal(last.role, "assistant");
  assert.equal(last.stopReason, "stop", last.errorMessage);
  assert.equal(last.content.at(-1)?.text, "done");
});

test("a stream with no events at all still trips the start guard", async () => {
  const startedAt = Date.now();
  const last = await runOnce(deadStreamFn());
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage, /^Provider stream start timed out after 200ms$/);
  assert.ok(Date.now() - startedAt < START_TIMEOUT_MS * 3, "dead stream must not be re-armed");
});
