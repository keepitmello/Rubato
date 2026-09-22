import { replaceOnce } from "./misc-replace.mjs";

/**
 * Anthropic 은 모델마다 Claude Code 하한을 둔다. 지금 가장 높은 하한이 이 값이다.
 *
 *   Fable 5.1 → 2.1.251, Opus 5.5 → 2.1.280
 *
 * 하한 아래로 보내면 서버가 `claude_code_version_too_old` 로 400 을 돌려준다 —
 * `user-agent` 만 봐서 정해지는 값이다 (2026-09-22 실측: 같은 body 가
 * `claude-cli/2.1.280` 으로는 통과하고 `claude-cli/2.1.277` 로는 거절된다).
 * 그래서 이 상수는 "이 기기 Claude Code 와 맞춘다"가 아니라 **쓰는 모델의 하한을
 * 덮는 값**이다. 기기 설치본이 이보다 낮아도 된다.
 */
export const CLAUDE_CODE_VERSION = "2.1.280";

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
