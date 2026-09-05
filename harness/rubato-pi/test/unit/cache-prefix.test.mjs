// Prompt-cache / Codex WS continuation needs request N to be a verbatim
// prefix of request N+1. Remap and Astra effort rewrite are allowed to
// move bytes once (notice-after-user hoist, Shift+Tab update insert);
// after that, appends must not reshuffle earlier items.
//
// Session 01a070da (2026-09-05): hidden wakes were pulled to a tail on
// every tool turn, so cacheRead stuck at tools+instructions (14976).
import assert from "node:assert/strict";
import test from "node:test";

import { remapHiddenCustomTurns } from "../../src/transforms/remap-hidden-custom-turns.mjs";
import { ASTRA_CODEX_PRELUDE } from "../../src/transforms/misc-astra-codex.mjs";

const { applyAstraConfigurationUpdate } = new Function(
  `${ASTRA_CODEX_PRELUDE}; return { applyAstraConfigurationUpdate };`,
)();

function convertOne(message) {
  if (message.role === "custom") {
    const content = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    return { role: "user", content, timestamp: message.timestamp ?? 0 };
  }
  return message;
}

function user(text, timestamp = 1) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(name, timestamp) {
  return { role: "assistant", content: [{ type: "toolCall", name }], timestamp };
}

function toolResult(text, timestamp) {
  return { role: "toolResult", content: [{ type: "text", text }], timestamp };
}

function hidden(text, timestamp, customType = "rubato-runtime:wake") {
  return {
    role: "custom",
    customType,
    display: false,
    content: text,
    timestamp,
  };
}

function remap(messages) {
  return remapHiddenCustomTurns(messages, convertOne);
}

function assertExtends(previous, next, label) {
  assert.ok(next.length >= previous.length, `${label}: shrunk ${previous.length} → ${next.length}`);
  for (let index = 0; index < previous.length; index += 1) {
    assert.deepEqual(next[index], previous[index], `${label}: first change at ${index}`);
  }
}

function play(steps, { allowRewriteAt } = {}) {
  const session = [];
  let previous = null;
  const snapshots = [];
  for (const step of steps) {
    const items = Array.isArray(step) ? step : [step];
    session.push(...items);
    const current = remap(session);
    const label = items.map((item) => item.role || item.customType).join("+");
    if (previous && !allowRewriteAt?.has(snapshots.length)) {
      assertExtends(previous, current, `after ${label} (#${snapshots.length})`);
    }
    previous = current;
    snapshots.push(current);
  }
  return snapshots;
}

test("#given a tool loop with interleaved wakes #when each turn remaps #then every request extends the previous prefix", () => {
  const snaps = play([
    user("go"),
    assistant("AgentSend", 2),
    toolResult("revived", 3),
    hidden("<peer_message from=\"runtime\">map</peer_message>", 4),
    assistant("AgentOutput", 5),
    toolResult("completed", 6),
    hidden("<peer_message from=\"shell\">bound</peer_message>", 7),
    assistant("eval", 8),
    toolResult("ok", 9),
    hidden("completed st_01a07123", 10),
    assistant("eval", 11),
    toolResult("next", 12),
  ]);
  const last = snaps.at(-1);
  assert.deepEqual(last.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "user",
    "assistant",
    "toolResult",
    "user",
    "assistant",
    "toolResult",
    "user",
    "assistant",
    "toolResult",
  ]);
  assert.equal(last[3].content[0].text, "<peer_message from=\"runtime\">map</peer_message>");
  assert.equal(last[6].content[0].text, "<peer_message from=\"shell\">bound</peer_message>");
});

test("#given two wakes in a row mid-loop #when the second arrives #then it appends instead of merging the previous wake", () => {
  const snaps = play([
    user("go"),
    assistant("eval", 2),
    toolResult("out", 3),
    hidden("wake-1", 4),
    hidden("wake-2", 5),
    assistant("eval", 6),
    toolResult("out2", 7),
  ]);
  assert.deepEqual(snaps[4].map((message) => message.role), ["user", "assistant", "toolResult", "user", "user"]);
  assert.equal(snaps[4][3].content[0].text, "wake-1");
  assert.equal(snaps[4][4].content[0].text, "wake-2");
});

test("#given a memory notice right after the user #when later tools append #then the hoist happens once and then the prefix is stable", () => {
  const snaps = play(
    [
      user("ㅇㅇ 해봐."),
      hidden("<memory_notice>after compact</memory_notice>", 2, "rubato-memory:notice"),
      assistant("eval", 3),
      toolResult("ok", 4),
      hidden("wake", 5),
      assistant("eval", 6),
      toolResult("ok2", 7),
    ],
    { allowRewriteAt: new Set([1]) },
  );
  assert.deepEqual(snaps[1].map((message) => message.role), ["assistant", "user"]);
  assert.equal(snaps[1][1].content[0].text, "ㅇㅇ 해봐.");
  assert.deepEqual(snaps.at(-1).map((message) => message.role), [
    "assistant",
    "user",
    "assistant",
    "toolResult",
    "user",
    "assistant",
    "toolResult",
  ]);
});

test("#given restoration then notice after the user #when they hoist #then they become one assistant before the user and later turns append", () => {
  const snaps = play(
    [
      user("continue"),
      hidden("[restored]", 2, "compaction.post-compact-restoration"),
      hidden("<memory_notice>", 3, "rubato-memory:notice"),
      assistant("eval", 4),
      toolResult("ok", 5),
    ],
    { allowRewriteAt: new Set([1, 2]) },
  );
  assert.deepEqual(snaps[2].map((message) => message.role), ["assistant", "user"]);
  assert.deepEqual(snaps[2][0].content.map((block) => block.text), ["[restored]", "<memory_notice>"]);
  assertExtends(snaps[2], snaps.at(-1), "after tools");
});

test("#given a trailing notice after an assistant #when a tool loop continues #then the notice stays a user tail and the request never ends on assistant", () => {
  const snaps = play([
    user("go"),
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
    hidden("<memory_notice>", 3, "rubato-memory:notice"),
    assistant("eval", 4),
    toolResult("ok", 5),
  ]);
  assert.equal(snaps[2].at(-1).role, "user");
  assert.equal(snaps.at(-1).at(-1).role, "toolResult");
});

test("#given remapped wakes #when Astra effort stays put across a tool loop #then configuration_update does not reshuffle the prefix", () => {
  const session = [];
  const model = { id: "gpt-6-astra" };
  let previous = null;
  const turns = [
    user("go"),
    assistant("AgentSend", 2),
    toolResult("revived", 3),
    hidden("wake-1", 4),
    assistant("AgentOutput", 5),
    toolResult("done", 6),
    hidden("wake-2", 7),
    assistant("eval", 8),
    toolResult("ok", 9),
  ];
  for (const [index, item] of turns.entries()) {
    session.push(item);
    if (index === 0) continue;
    const input = remap(session).map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const body = { model: "gpt-6-astra", input, reasoning: { effort: "medium", summary: "auto" } };
    applyAstraConfigurationUpdate(body, model, "cache-prefix-astra", "medium");
    assert.equal(body.input.filter((entry) => entry?.type === "configuration_update").length, 0);
    if (previous) assertExtends(previous, body.input, `astra turn ${index}`);
    previous = body.input;
  }
});

test("#given remapped wakes #when Astra effort changes once #then the update sits before the last user and later tool turns append", () => {
  const model = { id: "gpt-6-astra" };
  const firstSession = [
    user("go"),
    assistant("eval", 2),
    toolResult("out", 3),
    hidden("wake-1", 4),
  ];
  const first = {
    model: "gpt-6-astra",
    input: remap(firstSession).map((message) => ({ role: message.role, content: message.content })),
    reasoning: { effort: "low", summary: "auto" },
  };
  applyAstraConfigurationUpdate(first, model, "cache-prefix-effort", "low");
  applyAstraConfigurationUpdate(first, model, "cache-prefix-effort", "high");
  const update = first.input.find((entry) => entry?.type === "configuration_update");
  assert.deepEqual(update, { type: "configuration_update", reasoning: { effort: "high" } });
  assert.equal(first.input.at(-2), update);
  assert.equal(first.input.at(-1).role, "user");

  const secondSession = [
    ...firstSession,
    assistant("eval", 5),
    toolResult("out2", 6),
  ];
  const second = {
    model: "gpt-6-astra",
    input: remap(secondSession).map((message) => ({ role: message.role, content: message.content })),
    reasoning: { effort: "low", summary: "auto" },
  };
  applyAstraConfigurationUpdate(second, model, "cache-prefix-effort", "high");
  assertExtends(first.input, second.input, "astra after effort change");
});

test("#given an Astra effort change #when a later user keeps that effort #then the update stays put and the new user appends", () => {
  const model = { id: "gpt-6-astra" };
  const firstSession = [
    user("go"),
    assistant("eval", 2),
    toolResult("out", 3),
    hidden("wake-1", 4),
  ];
  const first = {
    model: "gpt-6-astra",
    input: remap(firstSession).map((message) => ({ role: message.role, content: message.content })),
    reasoning: { effort: "low", summary: "auto" },
  };
  applyAstraConfigurationUpdate(first, model, "cache-prefix-stay", "low");
  applyAstraConfigurationUpdate(first, model, "cache-prefix-stay", "high");
  const secondSession = [
    ...firstSession,
    assistant("eval", 5),
    toolResult("out2", 6),
    user("more", 7),
  ];
  const second = {
    model: "gpt-6-astra",
    input: remap(secondSession).map((message) => ({ role: message.role, content: message.content })),
    reasoning: { effort: "low", summary: "auto" },
  };
  applyAstraConfigurationUpdate(second, model, "cache-prefix-stay", "high");
  assert.equal(second.input.filter((entry) => entry?.type === "configuration_update").length, 1);
  assertExtends(first.input, second.input, "astra update stays put");
});
