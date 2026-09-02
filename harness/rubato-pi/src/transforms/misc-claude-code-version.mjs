import { replaceOnce } from "./misc-replace.mjs";

/** Fable 5.1 이 요구하는 하한은 2.1.251. 이 기기 Claude Code 와 맞춘다. */
export const CLAUDE_CODE_VERSION = "2.1.257";

const VERSION_NEEDLE = 'const claudeCodeVersion = "2.1.75";';
const VERSION_REPLACEMENT = `const claudeCodeVersion = "${CLAUDE_CODE_VERSION}";`;

export function isAnthropicMessagesUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/anthropic-messages.js");
}

/**
 * pinned anthropic-messages 의 Claude Code 신원을 현재 세대에 맞춘다.
 * Fable 5.1 은 2.1.75 를 거절한다.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectClaudeCodeVersion(source) {
  return replaceOnce(source, VERSION_NEEDLE, VERSION_REPLACEMENT, "claude-code-version");
}
