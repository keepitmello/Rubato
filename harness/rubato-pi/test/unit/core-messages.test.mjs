// Hidden custom messages must not become the latest user turn, and they are
// not the user's words. They also must not leave the request ending on an
// assistant turn — Fable 5.1 400s that as assistant prefill.
//
// Session 01a068e3 (2026-09-03): after a 644k-token pre_prompt compact the user
// sent "ㅇㅇ 해봐. 이어가기까지 잘 되는지..." twice. Both turns are in the
// jsonl. convertToLlm mapped rubato-memory:notice (and post-compact restoration)
// to role:user AFTER that text, so the model treated the notice as "this
// message" and answered the previous question / saved memory instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
import { remapHiddenCustomTurns } from "../../src/transforms/remap-hidden-custom-turns.mjs";
import { injectMessages, isMessagesUrl } from "../../src/transforms/core-messages.mjs";
import { injectContextTokensGuard, isContextTokensUrl } from "../../src/transforms/core-compaction.mjs";

const MESSAGES = `${senpiDir}/dist/core/messages.js`;

function convertOne(message) {
  if (message.role === "custom") {
    const content = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    return { role: "user", content, timestamp: message.timestamp ?? 0 };
  }
  return message;
}

function texts(message) {
  return (message.content ?? []).map((block) => block.text);
}

function assertEmptyUsage(message) {
  assert.equal(message.usage?.totalTokens, 0);
  assert.equal(message.usage?.input, 0);
  assert.equal(message.usage?.output, 0);
  assert.equal(message.usage?.cacheRead, 0);
  assert.equal(message.usage?.cacheWrite, 0);
}

test("isMessagesUrl matches senpi core messages", () => {
  assert.equal(isMessagesUrl("file:///x/@code-yeongyu/senpi/dist/core/messages.js"), true);
  assert.equal(isMessagesUrl("file:///x/@code-yeongyu/senpi/dist/core/agent-session.js"), false);
});

test("injectMessages remaps convertToLlm on the installed engine", () => {
  const source = readFileSync(MESSAGES, "utf8");
  const patched = injectMessages(source);
  assert.match(patched, /remapHiddenCustomTurns/);
  assert.doesNotMatch(patched, /\.filter\(\(m\) => m !== undefined\)/);
});

test("#given a user follow-up then a hidden memory notice #when convertToLlm remaps #then the notice is an assistant turn and the user text stays last", () => {
  const remapped = remapHiddenCustomTurns(
    [
      { role: "user", content: [{ type: "text", text: "ㅇㅇ 해봐. 이어가기까지 잘 되는지. aside 쪽 에이전트 의존 없이 스크립트로 도는 거 맞나?" }], timestamp: 1 },
      {
        role: "custom",
        customType: "rubato-memory:notice",
        display: false,
        content: "<memory_notice>\\n- After compaction: the latest user message is the primary task.\\n</memory_notice>",
        timestamp: 2,
      },
    ],
    convertOne,
  );

  assert.equal(remapped.length, 2);
  assert.equal(remapped[0].role, "assistant");
  assert.match(texts(remapped[0])[0], /memory_notice/);
  assertEmptyUsage(remapped[0]);
  assert.equal(remapped[1].role, "user");
  assert.equal(texts(remapped[1])[0].startsWith("ㅇㅇ 해봐."), true);
});

test("#given user then restoration then notice #when convertToLlm remaps #then both hidden customs become one assistant turn before the user", () => {
  const remapped = remapHiddenCustomTurns(
    [
      { role: "user", content: [{ type: "text", text: "continue the live test" }], timestamp: 1 },
      {
        role: "custom",
        customType: "compaction.post-compact-restoration",
        display: false,
        content: "[Restored context after compaction — files and skills from before compaction]",
        timestamp: 2,
      },
      {
        role: "custom",
        customType: "rubato-memory:notice",
        display: false,
        content: "<memory_notice>\\n- 10 user turns since your last memory save.\\n</memory_notice>",
        timestamp: 3,
      },
    ],
    convertOne,
  );

  assert.equal(remapped.length, 2);
  assert.equal(remapped[0].role, "assistant");
  assertEmptyUsage(remapped[0]);
  assert.deepEqual(texts(remapped[0]), [
    "[Restored context after compaction — files and skills from before compaction]",
    "<memory_notice>\\n- 10 user turns since your last memory save.\\n</memory_notice>",
  ]);
  assert.equal(remapped[1].role, "user");
  assert.equal(texts(remapped[1])[0], "continue the live test");
});

test("#given a hidden custom with no preceding user #when convertToLlm remaps #then it stays a user turn so the request is not assistant prefill", () => {
  const remapped = remapHiddenCustomTurns(
    [
      {
        role: "custom",
        customType: "rubato-memory:notice",
        display: false,
        content: "<memory_notice>",
        timestamp: 1,
      },
    ],
    convertOne,
  );
  assert.equal(remapped.length, 1);
  assert.equal(remapped[0].role, "user");
  assert.equal(texts(remapped[0])[0], "<memory_notice>");
  assertEmptyUsage(remapped[0]);
});

test("#given a visible custom after a user message #when convertToLlm remaps #then it stays a separate user turn", () => {
  const remapped = remapHiddenCustomTurns(
    [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      {
        role: "custom",
        customType: "goal-continuation",
        display: true,
        content: "continue the goal",
        timestamp: 2,
      },
    ],
    convertOne,
  );
  assert.equal(remapped.length, 2);
  assert.equal(remapped[0].role, "user");
  assert.equal(texts(remapped[0])[0], "hello");
  assert.equal(remapped[1].role, "user");
  assert.equal(texts(remapped[1])[0], "continue the goal");
});

test("#given assistant then hidden custom #when convertToLlm remaps #then the notice stays a user tail (no assistant prefill)", () => {
  const remapped = remapHiddenCustomTurns(
    [
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1 },
      {
        role: "custom",
        customType: "rubato-memory:notice",
        display: false,
        content: "<memory_notice>",
        timestamp: 2,
      },
    ],
    convertOne,
  );
  assert.equal(remapped.length, 2);
  assert.equal(remapped[0].role, "assistant");
  assert.equal(texts(remapped[0])[0], "done");
  assert.equal(remapped[1].role, "user");
  assert.equal(texts(remapped[1])[0], "<memory_notice>");
  assertEmptyUsage(remapped[1]);
});

test("#given user, assistant, then a trailing notice #when convertToLlm remaps #then the request ends on a user turn", () => {
  const remapped = remapHiddenCustomTurns(
    [
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
      {
        role: "custom",
        customType: "rubato-memory:notice",
        display: false,
        content: "<memory_notice>",
        timestamp: 3,
      },
    ],
    convertOne,
  );
  assert.deepEqual(remapped.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(texts(remapped[0])[0], "go");
  assert.equal(texts(remapped[1])[0], "done");
  assert.equal(texts(remapped[2])[0], "<memory_notice>");
  assert.notEqual(remapped[remapped.length - 1].role, "assistant");
});

test("#given prior reply then a new user and a notice #when convertToLlm remaps #then the notice sits between the prior assistant and the new user", () => {
  const remapped = remapHiddenCustomTurns(
    [
      { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "ㅇㅇ 해봐." }], timestamp: 3 },
      {
        role: "custom",
        customType: "rubato-memory:notice",
        display: false,
        content: "<memory_notice>",
        timestamp: 4,
      },
    ],
    convertOne,
  );
  assert.deepEqual(remapped.map((message) => message.role), ["user", "assistant", "assistant", "user"]);
  assert.equal(texts(remapped[2])[0], "<memory_notice>");
  assert.equal(texts(remapped[3])[0], "ㅇㅇ 해봐.");
});

test("installed convertToLlm remaps a trailing memory notice to assistant before the user", async () => {
  const url = pathToFileURL(MESSAGES).href;
  const { convertToLlm } = await import(url);
  const converted = convertToLlm([
    { role: "user", content: [{ type: "text", text: "ㅇㅇ 해봐. 이어가기까지 잘 되는지." }], timestamp: 1 },
    {
      role: "custom",
      customType: "rubato-memory:notice",
      content: "<memory_notice>\\n- After compaction: the latest user message is the primary task.\\n</memory_notice>",
      display: false,
      timestamp: 2,
    },
  ]);
  assert.equal(converted.length, 2);
  assert.equal(converted[0].role, "assistant");
  assertEmptyUsage(converted[0]);
  assert.match(texts(converted[0])[0], /After compaction/);
  assert.equal(converted[1].role, "user");
  assert.equal(texts(converted[1])[0], "ㅇㅇ 해봐. 이어가기까지 잘 되는지.");
});

test("injectContextTokensGuard skips totalTokens when usage is missing", () => {
  const estimate = `${senpiNested("@earendil-works", "pi-ai")}/dist/utils/estimate.js`;
  const source = readFileSync(estimate, "utf8");
  assert.equal(isContextTokensUrl(pathToFileURL(estimate).href), true);
  const patched = injectContextTokensGuard(source);
  assert.match(patched, /if \(!usage\) return 0;/);
});
