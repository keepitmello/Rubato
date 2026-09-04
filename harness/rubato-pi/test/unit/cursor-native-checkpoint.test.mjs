import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { senpiNested } from "../../src/engine-paths.mjs";
import { injectCursorAgent } from "../../src/transforms/cursor-agent.mjs";

test("cursor-agent transform pins RequestContext and echoes server checkpoints", () => {
  const source = readFileSync(senpiNested("@earendil-works/pi-ai/dist/api/cursor-agent.js"), "utf8");
  const patched = injectCursorAgent(source);
  assert.match(patched, /function pinRequestContext\(/);
  assert.match(patched, /serverCheckpointIds\.add\(conversationId\)/);
  assert.match(patched, /serverCheckpointIds\.has\(state\.conversationId\)/);
  assert.match(patched, /conversationState = state\.conversationState/);
  assert.doesNotMatch(
    patched,
    /Always override `rootPromptMessagesJson` and `turns` with content freshly/,
  );
  assert.match(patched, /pinRequestContext\(conversationId, requestContextTools\)/);
  assert.match(
    patched,
    /requestContext: pinRequestContext\(state\.conversationId, buildMcpToolDefinitions\(context\.tools\)\)/,
  );
});
