import assert from "node:assert/strict";
import test from "node:test";
import { remapHiddenCustomTurns } from "./remap-hidden-custom-turns.mjs";

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

test("#given a user follow-up then a hidden memory notice #when remapped #then the notice is an assistant turn and the user text stays last", () => {
  const remapped = remapHiddenCustomTurns(
    [
      { role: "user", content: [{ type: "text", text: "ㅇㅇ 해봐." }], timestamp: 1 },
      {
        role: "custom",
        customType: "rubato-memory:notice",
        display: false,
        content: "<memory_notice>after compaction</memory_notice>",
        timestamp: 2,
      },
    ],
    convertOne,
  );
  assert.equal(remapped.length, 2);
  assert.equal(remapped[0].role, "assistant");
  assert.match(texts(remapped[0])[0], /after compaction/);
  assert.equal(remapped[1].role, "user");
  assert.equal(texts(remapped[1])[0], "ㅇㅇ 해봐.");
});

test("#given assistant then hidden custom #when remapped #then the notice stays a user tail so the request is not assistant prefill", () => {
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
  assert.deepEqual(remapped.map((message) => message.role), ["assistant", "user"]);
});
