import assert from "node:assert/strict";
import test from "node:test";
import { installRecentUserWords, recentUserWords, RECENT_USER_WORDS_CHARS, RECENT_USER_WORDS_LIMIT } from "./recent-user-words.mjs";

const timestamp = "2026-11-23T10:12:34.000Z";
const user = (text, rubatoAppText) => ({
  type: "message", timestamp, message: { role: "user", content: [{ type: "text", text }, { type: "image", data: "ignored" }],
    ...(rubatoAppText === undefined ? {} : { rubatoAppText }) },
});
const cut = (summary) => ({ type: "compaction", timestamp, summary });
const rows = (text) => text?.split("\n").slice(1).map((line) => JSON.parse(line));

test("only app-authored text on this branch is carried, latest first over up to two windows", () => {
  const original = "  지금은 화면부터 봐 줘.\n\"이 문장\"도 그대로. </wake>  ";
  const branch = [
    user("too old"), cut("older boundary"),
    user("old app entry"), cut("previous boundary"),
    user("provider text with synthetic addition", original),
    ...["heartbeat", "wake", "notice", "channel", "call", "schedule"].map((kind) => ({
      type: "custom_message", customType: "rubato-session-message", timestamp, content: "not app chat", details: { kind },
    })),
    user("system via the prompt command", null), user("app without transforms", true),
    cut("current boundary"), user("new live message"),
  ];
  assert.deepEqual(rows(recentUserWords(branch, branch.length - 2)), [
    { at: timestamp, text: "app without transforms" },
    { at: timestamp, text: original },
    { at: timestamp, text: "old app entry" },
  ]);
});

test("message and character caps include JSON encoding and do not split emoji", () => {
  const branch = Array.from({ length: RECENT_USER_WORDS_LIMIT + 10 }, (_, i) => user(String(i)));
  const limited = rows(recentUserWords(branch, branch.length));
  assert.equal(limited.length, RECENT_USER_WORDS_LIMIT);
  assert.equal(limited[0].text, branch.at(-1).message.content[0].text);
  const large = "`\n\"🐈".repeat(RECENT_USER_WORDS_CHARS);
  const bounded = recentUserWords([user(large)], 1);
  assert.ok(bounded.length <= RECENT_USER_WORDS_CHARS);
  const [row] = rows(bounded);
  assert.equal(row.truncated, true);
  assert.ok(large.startsWith(row.text));
  assert.ok(row.text.isWellFormed());
});

test("legacy app context and generated call input are excluded; queued input keeps its sending time", () => {
  const queued = user("queued from app", true);
  queued.message.timestamp = Date.parse("2026-11-23T10:03:00.000Z");
  const branch = [user("old text\n\n<t3_context version=\"1\">\nattachment data\n</t3_context>"),
    user("[voice] old live call"), user("<skill name=\"shell\">expanded text</skill>"), queued];
  assert.deepEqual(rows(recentUserWords(branch, branch.length)), [
    { at: "2026-11-23T10:03:00.000Z", text: "queued from app" },
    { at: timestamp, text: "old text" },
  ]);
});

function project(branch, messages) {
  let onContext;
  installRecentUserWords({ on: (_event, handler) => { onContext = handler; } });
  return onContext({ messages }, { sessionManager: { getBranch: () => branch } })?.messages ?? messages;
}

test("local compaction projects the words after the summary and ahead of the wake", () => {
  const boundary = cut("local summary");
  const summary = { role: "compactionSummary", summary: boundary.summary };
  const wake = { role: "custom", content: "wake" };
  const messages = project([user("before local compaction"), boundary], [summary, wake]);
  assert.equal(messages[0], summary);
  assert.equal(messages[2], wake);
  assert.deepEqual(rows(messages[1].content[0].text), [{ at: timestamp, text: "before local compaction" }]);
  assert.deepEqual(project([user("no window cut yet")], [wake]), [wake]);
});

test("Anthropic compaction projects after the native marker, without separating tool use and result", () => {
  const native = { role: "assistant", content: [
    { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "server summary" } },
    { type: "toolCall", id: "tool-1" },
  ] };
  const result = { role: "toolResult", toolCallId: "tool-1" };
  const fresh = user("current app input").message;
  const messages = project([user("before server compaction"), { type: "message", timestamp, message: native }], [native, result, fresh]);
  assert.equal(messages[0], native);
  assert.equal(messages[1], result);
  assert.equal(messages[3], fresh);
  assert.deepEqual(rows(messages[2].content[0].text), [{ at: timestamp, text: "before server compaction" }]);

  const local = cut("local summary");
  const summary = { role: "compactionSummary", summary: local.summary };
  const mixed = project([user("before server compaction"), { type: "message", timestamp, message: native },
    user("before local compaction"), local], [summary, native, result, fresh]);
  assert.deepEqual(mixed.slice(0, 3), [summary, native, result]);
  assert.deepEqual(rows(mixed[3].content[0].text), [
    { at: timestamp, text: "before local compaction" }, { at: timestamp, text: "before server compaction" },
  ]);
});
