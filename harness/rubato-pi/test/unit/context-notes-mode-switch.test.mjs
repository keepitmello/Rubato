import assert from "node:assert/strict";
import test from "node:test";

import {
  considerContextModeSwitch,
  hasNotesWindowBoundary,
} from "../../src/context-notes/mode-policy.mjs";
import { INIT_ENTRY, SOURCE, encodeBootstrap, initialWindow, nextWindow } from "../../src/context-notes/protocol.mjs";

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra" };
const SUMMARY = "summary";
const NOTES = "history-notes";

function user(text = "already talked") {
  return { type: "message", id: "m1", parentId: null, message: { role: "user", content: text } };
}

test("a used summary session without a mode record must not switch silently", async () => {
  const confirms = [];
  const decision = await considerContextModeSwitch({
    model: ASTRA,
    source: "set",
    currentMode: SUMMARY,
    branch: [user()],
    confirm: async () => {
      confirms.push(true);
      return false;
    },
    notify: () => {},
    declined: new Set(),
  });
  assert.equal(confirms.length, 1, `confirm was not called; decision=${JSON.stringify(decision)}`);
  assert.equal(decision.action, "keep");
  assert.equal(decision.declined, true);
});

test("a blank session still adopts the first model without a confirm, even after a provisional init", async () => {
  const init = { type: "custom", customType: INIT_ENTRY, data: { window: initialWindow() } };
  const decision = await considerContextModeSwitch({
    model: { provider: "claude-sdk-oauth", id: "claude-fable-5-1" },
    source: "set",
    currentMode: NOTES,
    branch: [init],
    confirm: async () => { throw new Error("fresh session must not confirm"); },
  });
  assert.deepEqual(decision, { action: "switch", mode: SUMMARY });
});

test("a confirm answered after a notes boundary appeared does not switch to summary", async () => {
  const window0 = initialWindow();
  const window1 = nextWindow(window0);
  const boundary = {
    type: "compaction",
    summary: encodeBootstrap(window1),
    details: { source: SOURCE, window: window1 },
  };
  let live = [
    { type: "message", id: "m1", parentId: null, message: { role: "user", content: "talked" } },
    { type: "custom", customType: INIT_ENTRY, data: { window: window0 } },
  ];
  const notices = [];
  const decision = await considerContextModeSwitch({
    model: { provider: "claude-sdk-oauth", id: "claude-fable-5-1" },
    source: "set",
    currentMode: NOTES,
    branch: live,
    readBranch: () => live,
    confirm: async () => {
      live = [...live, boundary];
      return true;
    },
    notify: (message) => notices.push(message),
  });
  assert.equal(hasNotesWindowBoundary(live), true);
  assert.equal(decision.action, "keep");
  assert.equal(decision.refused, true);
  assert.equal(notices.length, 1);
});

test("a tree jump that empties the live branch still confirms when the session has talked", async () => {
  const confirms = [];
  const decision = await considerContextModeSwitch({
    model: ASTRA,
    source: "set",
    currentMode: SUMMARY,
    branch: [],
    sessionEntries: [user("visible"), { type: "message", id: "a1", message: { role: "assistant", content: "reply" } }],
    confirm: async () => {
      confirms.push(true);
      return false;
    },
  });
  assert.equal(confirms.length, 1);
  assert.equal(decision.action, "keep");
});
