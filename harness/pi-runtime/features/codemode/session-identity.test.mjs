import assert from "node:assert/strict";
import test from "node:test";

import { detachedNotificationKey } from "./src/extension/eval-notifier.ts";
import { isSameCodemodeSession, sessionFileFromContext, sessionIdFromEvent } from "./src/extension/runtime-factory.ts";

test("same session file keeps the running chat even when session_start omits sessionId", () => {
	const current = { sessionId: "old-random", sessionFile: "/tmp/chat.jsonl" };
	assert.equal(isSameCodemodeSession(current, { sessionFile: "/tmp/chat.jsonl" }), true);
	assert.equal(isSameCodemodeSession(current, { sessionFile: "/tmp/other.jsonl" }), false);
});

test("same sessionId matches only when the session file is unknown", () => {
	const current = { sessionId: "sess-1" };
	assert.equal(isSameCodemodeSession(current, { sessionId: "sess-1" }), true);
	assert.equal(isSameCodemodeSession(current, { sessionId: "sess-2" }), false);
	assert.equal(isSameCodemodeSession(undefined, { sessionId: "sess-1" }), false);
});

test("session identity helpers read the host event and session file", () => {
	assert.equal(sessionIdFromEvent({ sessionId: "abc" }), "abc");
	assert.equal(sessionIdFromEvent({}), undefined);
	assert.equal(sessionFileFromContext({ sessionManager: { getSessionFile: () => "/tmp/chat.jsonl" } }), "/tmp/chat.jsonl");
	assert.equal(sessionFileFromContext({}), undefined);
});

test("cancelled and failed notices for one tool call share a notification key", () => {
	const cancelled = "call-25b79244-b5c9-4355-805e-b7f2e147d37e-11\nfc_p1cfsn4-aws_ue1_0-2";
	const failed = "call-25b79244-b5c9-4355-805e-b7f2e147d37e-11\nfc_p1cfsn4-aws_ue1_0";
	assert.equal(detachedNotificationKey(cancelled), detachedNotificationKey(failed));
	assert.equal(detachedNotificationKey("cell-detached"), "cell-detached");
});
