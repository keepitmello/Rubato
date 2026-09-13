import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collapseConsecutiveTools } from "./assistant-phase.mjs";
import { patchAssistantMessage, patchInteractiveTurnChrome } from "./patches.mjs";

const stock = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@earendil-works/pi-coding-agent/dist");

test("bash·read·bash keeps two bash names; only consecutive names count", () => {
  const named = (name) => ({ name, failed: false });
  assert.deepEqual(
    collapseConsecutiveTools([named("bash"), named("read"), named("bash")]).map(({ name, count }) => `${name}:${count}`),
    ["bash:1", "read:1", "bash:1"],
  );
  assert.deepEqual(
    collapseConsecutiveTools([named("bash"), named("bash"), named("read")]).map(({ name, count }) => `${name}:${count}`),
    ["bash:2", "read:1"],
  );
});

test("turn chrome hosts thinking on one toggle and skips per-message thinking", () => {
  const assistant = patchAssistantMessage(readFileSync(join(stock, "modes/interactive/components/assistant-message.js"), "utf8"));
  assert.match(assistant, /setHostThinking\(hosted\)/);
  assert.match(assistant, /this\.turnWorkCollapsed \|\| this\.hostThinking/);
  const interactive = patchInteractiveTurnChrome(readFileSync(join(stock, "modes/interactive/interactive-mode.js"), "utf8"));
  assert.match(interactive, /TurnThinkingComponent/);
  assert.match(interactive, /this\.streamingComponent\.setHostThinking\?\.\(true\)/);
  assert.match(interactive, /this\.turnThinking\?\.trackAssistant/);
});
