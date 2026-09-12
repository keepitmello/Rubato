import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_BILLING_HEADER,
  CLAUDE_CODE_VERSION,
  injectClaudeCodeBillingHeader,
  injectClaudeCodeVersion,
} from "../../src/transforms/misc-claude-code-version.mjs";

test("Claude Code version and billing header are injected once", () => {
  const source = [
    'const claudeCodeVersion = "2.1.251";',
    "    if (isOAuthToken) {",
    "        params.system = [",
    "            {",
    '                type: "text",',
    '                text: "You are Claude Code, Anthropic\'s official CLI for Claude.",',
    "            },",
    "        ];",
    "    }",
  ].join("\n");

  const next = injectClaudeCodeBillingHeader(injectClaudeCodeVersion(source));
  assert.match(next, new RegExp(`const claudeCodeVersion = "${CLAUDE_CODE_VERSION}";`));
  assert.equal(next.includes(CLAUDE_CODE_BILLING_HEADER), true);
  assert.equal(next.split("You are Claude Code, Anthropic's official CLI for Claude.").length, 2);
  assert.ok(next.indexOf(CLAUDE_CODE_BILLING_HEADER) < next.indexOf("You are Claude Code"));
});
