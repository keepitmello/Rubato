import { replaceOnce } from "./misc-replace.mjs";

/** Fable 5.1 이 요구하는 하한은 2.1.251. 이 기기 Claude Code 와 맞춘다. */
export const CLAUDE_CODE_VERSION = "2.1.269";

/** First OAuth system block. Routes the request onto the Claude Code weekly pool. */
export const CLAUDE_CODE_BILLING_HEADER =
  `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}; cc_entrypoint=cli;`;

const VERSION_NEEDLE = 'const claudeCodeVersion = "2.1.251";';
const VERSION_REPLACEMENT = `const claudeCodeVersion = "${CLAUDE_CODE_VERSION}";`;
const IDENTITY_NEEDLE = 'text: "You are Claude Code, Anthropic\'s official CLI for Claude.",';
const IDENTITY_REPLACEMENT = `text: "${CLAUDE_CODE_BILLING_HEADER}",
            },
            {
                type: "text",
                text: "You are Claude Code, Anthropic's official CLI for Claude.",`;

export function isAnthropicMessagesUrl(url) {
  return url.includes("pi-ai/dist/api/anthropic-messages.js");
}

/**
 * pinned anthropic-messages 의 Claude Code 신원을 현재 세대에 맞춘다.
 * Fable 5.1 은 2.1.75 를 거절한다.
 * billing header 가 빠지면 통합 주간이 남아도 Opus/Sonnet 이 raw API 로 429 난다.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectClaudeCodeVersion(source) {
  return replaceOnce(source, VERSION_NEEDLE, VERSION_REPLACEMENT, "claude-code-version");
}

export function injectClaudeCodeBillingHeader(source) {
  return replaceOnce(source, IDENTITY_NEEDLE, IDENTITY_REPLACEMENT, "claude-code-billing-header");
}
