import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { senpiNested } from "../../src/engine-paths.mjs";
import {
  injectAdaptiveToolTurnEffort,
  isAdaptiveToolTurnEffortUrl,
} from "../../src/transforms/misc-adaptive-tool-turn-effort.mjs";

test("사고 없는 tool_use 턴 뒤에도 thinking/effort 를 유지한다", () => {
  const source = readFileSync(senpiNested("@earendil-works/pi-ai/dist/api/anthropic-messages.js"), "utf8");
  const pristine = /if \(params\.thinking && params\.thinking\.type !== "disabled" && finalAssistantTurnStartsWithToolUse\(params\.messages\)\)\n\s+disableThinkingForRequest\(params, model, compat\);/;
  assert.match(source, pristine);
  const next = injectAdaptiveToolTurnEffort(source);
  assert.doesNotMatch(next, pristine);
  assert.match(next, /if \(false && params\.thinking/);
  assert.throws(() => injectAdaptiveToolTurnEffort(next));
  assert.equal(isAdaptiveToolTurnEffortUrl("file:///x/@earendil-works/pi-ai/dist/api/anthropic-messages.js"), true);
  assert.equal(isAdaptiveToolTurnEffortUrl("file:///x/@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js"), false);
});
