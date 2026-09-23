import test from "node:test";
import assert from "node:assert/strict";
import { contextMode, contextNotesConfig, windowBudget } from "../../src/context-notes/config.mjs";
import { hardSafetyLine, outputReserveTokens, safetyMarginTokens } from "../../src/context-budget.mjs";
import { initialWindow, nextWindow, encodeBootstrap, decodeBootstrap, bootstrapMessage,
  validateWindow, validateTransition, notePath, SOURCE } from "../../src/context-notes/protocol.mjs";

test("new default and explicit legacy mode; invalid values fail closed", () => {
  assert.equal(contextMode({}), "history-notes");
  assert.equal(contextMode({ RUBATO_CONTEXT_MODE: "summary" }), "summary");
  assert.throws(() => contextMode({ RUBATO_CONTEXT_MODE: "typo" }));
  assert.throws(() => contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS: "NaN" }));
  assert.throws(() => contextNotesConfig({ RUBATO_CONTEXT_REMINDER_TOKENS: "1" }));
});
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000, maxTokens: 128000 };
const GROK = { provider: "xai", id: "grok-4.7", contextWindow: 500000, maxTokens: 128000 };
const CURSOR_GROK = { provider: "cursor", id: "grok-4.7-fast", contextWindow: 500000 };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5-sub", contextWindow: 1000000, maxTokens: 128000 };
const DEEPSEEK = { provider: "b-ai", id: "deepseek-v4.1-flash", contextWindow: 1000000, maxTokens: 384000 };
const GEMINI = { provider: "google-antigravity", id: "gemini-3.8-flash", contextWindow: 1048576, maxTokens: 65536 };

test("Astra keeps 90% target, 95% hard and the reminder 6144 tokens before the target", () => {
  const astra = windowBudget(ASTRA, contextNotesConfig({}));
  assert.equal(astra.strategy, "notes-rollover");
  assert.equal(astra.target, 244800);
  assert.equal(astra.hard, 258400);
  assert.equal(astra.reminderAt, 238656);
  assert.equal(astra.soft, astra.target);
  // The whole Codex lane shares Astra's lines.
  for (const id of ["gpt-6-astra-sub", "gpt-5.6-sol", "gpt-5.6-sol-sub", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const codex = windowBudget({ ...ASTRA, id });
    assert.equal(codex.strategy, "notes-rollover", id);
    assert.deepEqual([codex.reminderAt, codex.target, codex.hard], [astra.reminderAt, astra.target, astra.hard], id);
  }
  // An explicit override lowers the target but never raises a line past 90%.
  assert.equal(windowBudget(ASTRA, contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS: "900000" })).target, 244800);
  assert.equal(windowBudget(ASTRA, contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS: "200000" })).target, 200000);
  assert.throws(() => windowBudget({ contextWindow: 0 }));
});

test("Grok does not stop at the 200K price boundary: soft 300K, target 320K, hard 400K", () => {
  for (const model of [GROK, CURSOR_GROK]) {
    const grok = windowBudget(model, contextNotesConfig({}));
    assert.equal(grok.strategy, "notes-rollover");
    assert.deepEqual([grok.soft, grok.target, grok.hard], [300000, 320000, 400000]);
    assert.ok(grok.reminderAt > 200000);
  }
});

test("Claude has no Rubato line; its only line is the server-compaction safety line", () => {
  const opus = windowBudget(OPUS, contextNotesConfig({}));
  assert.equal(opus.strategy, "server-compaction");
  assert.deepEqual([opus.soft, opus.target, opus.hard, opus.reminderAt], [undefined, undefined, undefined, undefined]);
  assert.equal(opus.safetyLine, hardSafetyLine(OPUS));
  assert.equal(opus.nudgeTokens, 200000);
});

test("DeepSeek, Gemini and other models only have a computed hard safety line", () => {
  const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5", contextWindow: 200000, maxTokens: 64000 };
  for (const model of [DEEPSEEK, GEMINI, HAIKU]) {
    const budget = windowBudget(model, contextNotesConfig({}));
    assert.equal(budget.strategy, "hard-safety");
    assert.equal(budget.hard, hardSafetyLine(model));
    assert.equal(budget.soft, budget.hard); assert.equal(budget.target, budget.hard);
    assert.equal(budget.hard, model.contextWindow - outputReserveTokens(model) - safetyMarginTokens(model));
  }
  // The reserve is Rubato's configured output reserve, not the catalog maximum: DeepSeek's
  // 384K max output does not pull its line down to ~600K.
  assert.ok(windowBudget(DEEPSEEK).hard > 900000);
  const tuned = contextNotesConfig({ RUBATO_CONTEXT_OUTPUT_RESERVE_TOKENS: "100000", RUBATO_CONTEXT_SAFETY_MARGIN_TOKENS: "0" });
  assert.equal(windowBudget(DEEPSEEK, tuned).hard, 900000);
});

test("note nudge interval is 20% of the window and configurable", () => {
  assert.equal(windowBudget(ASTRA).nudgeTokens, 54400);
  assert.equal(windowBudget(GROK).nudgeTokens, 100000);
  assert.equal(windowBudget(DEEPSEEK, contextNotesConfig({ RUBATO_CONTEXT_NOTE_NUDGE_RATIO: "0.1" })).nudgeTokens, 100000);
  assert.equal(windowBudget(DEEPSEEK, contextNotesConfig({ RUBATO_CONTEXT_NOTE_NUDGE_RATIO: "0" })).nudgeTokens, undefined);
  assert.throws(() => contextNotesConfig({ RUBATO_CONTEXT_NOTE_NUDGE_RATIO: "2" }));
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
