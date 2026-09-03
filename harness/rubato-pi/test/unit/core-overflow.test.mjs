import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
import { injectAgentSession } from "../../src/transforms/core-agent-session.mjs";
import { injectOverflow, isOverflowUrl } from "../../src/transforms/core-overflow.mjs";

function pinnedOverflow() {
  return readFileSync(senpiNested("@earendil-works", "pi-ai", "dist/utils/overflow.js"), "utf8");
}

test("silent overflow on a successful stop ignores cacheRead", () => {
  const source = pinnedOverflow();
  assert.match(source, /stopReason === "stop"[\s\S]*?usage\.input \+ message\.usage\.cacheRead/);
  const next = injectOverflow(source);
  const stopCase = next.slice(next.indexOf('message.stopReason === "stop"'));
  assert.match(stopCase, /const inputTokens = message\.usage\.input \?\? 0;/);
  assert.doesNotMatch(stopCase.slice(0, 400), /usage\.input \+ message\.usage\.cacheRead/);
  assert.throws(() => injectOverflow(next));
  assert.equal(isOverflowUrl("file:///x/@earendil-works/pi-ai/dist/utils/overflow.js"), true);
});

test("agent-session drops billed tokens that exceed the window when local estimate fits", () => {
  const source = readFileSync(join(senpiDir, "dist/core/agent-session.js"), "utf8");
  const next = injectAgentSession(source);
  assert.match(next, /if \(window > 0 && resolved > window && estimate > 0 && estimate <= window\)/);
  assert.match(next, /if \(local > 0 && local <= contextWindow\) tokens = local;/);
});
