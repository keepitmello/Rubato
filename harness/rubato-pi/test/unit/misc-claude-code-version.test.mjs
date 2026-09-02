import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { senpiNested } from "../../src/engine-paths.mjs";
import {
  CLAUDE_CODE_VERSION,
  injectClaudeCodeVersion,
  isAnthropicMessagesUrl,
} from "../../src/transforms/misc-claude-code-version.mjs";

test("Claude Code 신원을 2.1.257 로 올린다", () => {
  const source = readFileSync(senpiNested("@earendil-works/pi-ai/dist/api/anthropic-messages.js"), "utf8");
  assert.match(source, /const claudeCodeVersion = "2\.1\.75";/);
  const next = injectClaudeCodeVersion(source);
  assert.match(next, new RegExp(`const claudeCodeVersion = "${CLAUDE_CODE_VERSION}";`));
  assert.doesNotMatch(next, /const claudeCodeVersion = "2\.1\.75";/);
  assert.equal(isAnthropicMessagesUrl("file:///x/@earendil-works/pi-ai/dist/api/anthropic-messages.js"), true);
  assert.equal(isAnthropicMessagesUrl("file:///x/@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js"), false);
});
