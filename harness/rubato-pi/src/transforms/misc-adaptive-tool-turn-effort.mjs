import { replaceOnce } from "./misc-replace.mjs";

const NEEDLE = "    if (params.thinking && params.thinking.type !== \"disabled\" && finalAssistantTurnStartsWithToolUse(params.messages))\n        disableThinkingForRequest(params, model, compat);";

const REPLACEMENT = "    // Rubato: 이 degrade 를 타지 않는다. 사고 없이 tool_use 로 시작한 assistant 턴 뒤에\n    // thinking 설정을 그대로 두고 보내도 Anthropic 은 200 을 준다(2026-09-02 실측: Opus 5,\n    // Sonnet 5, Fable 5.1 adaptive / Haiku 4.5 budget). 그런데 이 분기는 그런 턴마다\n    // adaptive 모델은 thinking 삭제 + effort low, budget 모델은 thinking disabled 로 바꿔\n    // (1) 도구 루프 후속 호출을 low 로 돌리고 (2) thinking 설정 변경으로 messages 캐시를\n    // 매번 다시 쓰게 했다 (cache_miss_reason: unavailable). 실 세션 집계: Opus 5 도구 턴의\n    // 96% 가 사고 없이 시작.\n    if (false && params.thinking && params.thinking.type !== \"disabled\" && finalAssistantTurnStartsWithToolUse(params.messages))\n        disableThinkingForRequest(params, model, compat);";

export function isAdaptiveToolTurnEffortUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/anthropic-messages.js");
}

/**
 * pinned anthropic-messages 의 "마지막 assistant 턴이 사고 없이 tool_use 로 시작하면
 * thinking 을 끄고 effort 를 low 로" 분기를 비활성화한다. 피커의 네 모델 전부 그 기록을
 * 그대로 받는다.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectAdaptiveToolTurnEffort(source) {
  return replaceOnce(source, NEEDLE, REPLACEMENT, "adaptive-tool-turn-effort");
}
