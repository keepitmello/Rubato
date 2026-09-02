import { replaceOnce } from "./misc-replace.mjs";

const NEEDLE = "    if (params.thinking && params.thinking.type !== \"disabled\" && finalAssistantTurnStartsWithToolUse(params.messages))\n        disableThinkingForRequest(params, model, compat);";

const REPLACEMENT = "    // Rubato: adaptive 모델은 이 degrade 를 타지 않는다. 사고 없이 tool_use 로 시작한\n    // assistant 턴 뒤에 adaptive thinking + 원래 effort 로 보내도 Anthropic 은 200 을\n    // 준다(2026-09-02 Fable 5.1 실측). 그런데 이 분기는 그런 턴마다 thinking 을 지우고\n    // effort 를 low 로 내려, 도구 루프의 후속 호출이 전부 low 로 돌았다 (실 세션 집계:\n    // Opus 5 도구 턴의 96% 가 사고 없이 시작).\n    if (params.thinking && params.thinking.type !== \"disabled\" && !supportsAdaptiveThinking(model) && finalAssistantTurnStartsWithToolUse(params.messages))\n        disableThinkingForRequest(params, model, compat);";

export function isAdaptiveToolTurnEffortUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/anthropic-messages.js");
}

/**
 * pinned anthropic-messages 의 "마지막 assistant 턴이 사고 없이 tool_use 로 시작하면
 * thinking 을 끄고 effort 를 low 로" 분기를 adaptive 모델에서 비활성화한다.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectAdaptiveToolTurnEffort(source) {
  return replaceOnce(source, NEEDLE, REPLACEMENT, "adaptive-tool-turn-effort");
}
