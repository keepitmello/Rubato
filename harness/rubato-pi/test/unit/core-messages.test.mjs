// Hidden custom messages must not become the latest user turn.
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

import { senpiDir } from "../../src/engine-paths.mjs";
import { foldHiddenCustomUserTurns } from "../../src/transforms/fold-hidden-custom-user-turns.mjs";
import { injectMessages, isMessagesUrl } from "../../src/transforms/core-messages.mjs";

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

test("isMessagesUrl matches senpi core messages", () => {
  assert.equal(isMessagesUrl("file:///x/@code-yeongyu/senpi/dist/core/messages.js"), true);
  assert.equal(isMessagesUrl("file:///x/@code-yeongyu/senpi/dist/core/agent-session.js"), false);
});

test("injectMessages folds convertToLlm on the installed engine", () => {
  const source = readFileSync(MESSAGES, "utf8");
  const patched = injectMessages(source);
  assert.match(patched, /foldHiddenCustomUserTurns/);
  assert.doesNotMatch(patched, /\.filter\(\(m\) => m !== undefined\)/);
});

test("#given a user follow-up then a hidden memory notice #when convertToLlm folds #then the latest user turn still starts with the user text", () => {
  const folded = foldHiddenCustomUserTurns(
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

  assert.equal(folded.length, 1);
  assert.equal(folded[0].role, "user");
  assert.equal(folded[0].content[0].text.startsWith("ㅇㅇ 해봐."), true);
  assert.match(folded[0].content[1].text, /memory_notice/);
});

test("#given user then restoration then notice #when convertToLlm folds #then both hidden customs attach to the same user turn", () => {
  const folded = foldHiddenCustomUserTurns(
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

  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].content.map((block) => block.text), [
    "continue the live test",
    "[Restored context after compaction — files and skills from before compaction]",
    "<memory_notice>\\n- 10 user turns since your last memory save.\\n</memory_notice>",
  ]);
});

test("#given a hidden custom with no preceding user #when convertToLlm folds #then it stays its own user turn", () => {
  const folded = foldHiddenCustomUserTurns(
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
  assert.equal(folded.length, 1);
  assert.equal(folded[0].role, "user");
  assert.equal(folded[0].content[0].text, "<memory_notice>");
});

test("#given a visible custom after a user message #when convertToLlm folds #then it stays a separate user turn", () => {
  const folded = foldHiddenCustomUserTurns(
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
  assert.equal(folded.length, 2);
  assert.equal(folded[0].content[0].text, "hello");
  assert.equal(folded[1].content[0].text, "continue the goal");
});

test("#given assistant then hidden custom #when convertToLlm folds #then the custom stays its own user turn", () => {
  const folded = foldHiddenCustomUserTurns(
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
  assert.equal(folded.length, 2);
  assert.equal(folded[0].role, "assistant");
  assert.equal(folded[1].role, "user");
});

test("installed convertToLlm folds a trailing memory notice into the user turn", async () => {
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
  assert.equal(converted.length, 1);
  assert.equal(converted[0].role, "user");
  assert.equal(converted[0].content[0].text, "ㅇㅇ 해봐. 이어가기까지 잘 되는지.");
  assert.match(converted[0].content[1].text, /After compaction/);
});
