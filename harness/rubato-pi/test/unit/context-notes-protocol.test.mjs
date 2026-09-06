import test from "node:test";
import assert from "node:assert/strict";
import { contextMode, contextNotesConfig, windowBudget } from "../../src/context-notes/config.mjs";
import { initialWindow, nextWindow, encodeBootstrap, decodeBootstrap, bootstrapMessage,
  validateWindow, validateTransition, notePath, SOURCE } from "../../src/context-notes/protocol.mjs";

test("new default and explicit legacy mode; invalid values fail closed", () => {
  assert.equal(contextMode({}), "history-notes");
  assert.equal(contextMode({ RUBATO_CONTEXT_MODE: "summary" }), "summary");
  assert.throws(() => contextMode({ RUBATO_CONTEXT_MODE: "typo" }));
  assert.throws(() => contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS: "NaN" }));
  assert.throws(() => contextNotesConfig({ RUBATO_CONTEXT_REMINDER_TOKENS: "1" }));
});
test("input experiment budget leaves physical headroom", () => {
  assert.deepEqual(windowBudget({ contextWindow: 100000 }, contextNotesConfig({})), { target: 80000, reminder: 6144, full: 100000 });
  assert.equal(windowBudget({ contextWindow: 100000 }, contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS: "120000" })).target, 90000);
  assert.throws(() => windowBudget({ contextWindow: 0 }));
});
test("UUIDv7 chain and deterministic metadata carrier, never a generated summary", () => {
  const a = initialWindow(), b = nextWindow(a);
  assert.match(a.windowId, /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(b.firstWindowId, a.windowId); assert.equal(b.previousWindowId, a.windowId);
  assert.equal(b.number, 1); assert.notEqual(a.windowId, b.windowId);
  const encoded = encodeBootstrap(b, '- "work.md" (100 bytes)');
  assert.equal(decodeBootstrap(encoded).windowId, b.windowId);
  assert.equal(bootstrapMessage(encoded, "2026-01-01").role, "user");
  assert.equal(bootstrapMessage("Old normal summary"), undefined);
  assert.throws(() => decodeBootstrap(encoded.slice(0, -1)));
  assert.throws(() => validateWindow({ ...a, windowId: "ffffffff--------------------------------" }));
  assert.throws(() => encodeBootstrap(a, "가".repeat(1334)));
});
test("summary requests are refused; metadata must agree", () => {
  const a = initialWindow();
  assert.throws(() => validateTransition({ summary: "summary", details: {} }));
  const good = { summary: encodeBootstrap(a), firstKeptEntryId: "item", details: { source: SOURCE, window: a } };
  assert.doesNotThrow(() => validateTransition(good));
  assert.throws(() => validateTransition({ ...good, details: { source: SOURCE, window: { ...a, number: 3 } } }));
});
test("notes use validated virtual paths, never filesystem traversal", () => {
  assert.equal(notePath("/root/notes/tasks/현재.md"), "tasks/현재.md");
  for (const path of ["", "../secret", "a/../b", "a//b", "/etc/passwd", "a\\b", "a\0b", "a/."]) assert.throws(() => notePath(path));
});
