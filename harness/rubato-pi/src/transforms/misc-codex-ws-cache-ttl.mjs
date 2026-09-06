import { replaceOnce } from "./misc-replace.mjs";

const TTL_NEEDLE = "const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;";
const TTL_REPLACEMENT = "const SESSION_WEBSOCKET_CACHE_TTL_MS = 30 * 60 * 1000;";

const UNREF_NEEDLE = "    }, SESSION_WEBSOCKET_CACHE_TTL_MS);";
const UNREF_REPLACEMENT = "    }, SESSION_WEBSOCKET_CACHE_TTL_MS);\n    entry.idleTimer.unref?.();";

export function isCodexWsCacheTtlUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/openai-codex-responses.js");
}

/**
 * Codex WS 세션 소켓 idle TTL 5분 → 30분.
 * 캐시된 소켓이 `previous_response_id` 이어가기를 들고 있어서, 5분 유휴면
 * 다음 턴이 전체 컨텍스트를 다시 보낸다. GPT-5.6+ prompt-cache TTL(1800s) 과 맞춘다.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectCodexWsCacheTtl(source) {
  let next = replaceOnce(source, TTL_NEEDLE, TTL_REPLACEMENT, "codex-ws cache ttl");
  return replaceOnce(next, UNREF_NEEDLE, UNREF_REPLACEMENT, "codex-ws cache ttl unref");
}
