export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_CAP_MS = 48 * 60 * 60 * 1_000;
export const RETRY_SAME_MAX_ATTEMPTS = 2;
export const TURN_RETRY_SUPPRESSION_PREFIX = "rubato:no-turn-retry:";

const INVALID_KEY_TEXT = /invalid[ _-]?(?:api[ _-]?)?key|authentication[_ ]?error|invalid x-api-key|unauthorized/i;
const ACCOUNT_SCOPED_403_TEXT = /account|credential|token|api[ _-]?key|organization|subscription/i;
const RATE_LIMIT_TEXT = /rate[ _-]?limit|too many requests|resource_exhausted/i;
const BILLING_TEXT = /billing|credits?[ _-]?(?:required|exhausted|balance)|insufficient[ _-]?(?:funds|quota|credit)|payment[ _-]?required|quota[ _-]?exhausted/i;
const OVERLOAD_TEXT = /overloaded/i;
// Anthropic answers fast mode on an account without usage credits with 429
// "Usage credits are required for fast mode." The account is fine for normal speed, so
// blocking it as rate-limited hid that reason behind "Account 'sub' is unavailable".
const FAST_MODE_CREDITS_TEXT = /required for fast mode/i;
// `connection error` 는 Anthropic/OpenAI SDK 의 APIConnectionError("Connection error."),
// `terminated`·`other side closed` 는 undici 가 소켓을 잃을 때 올리는 문구다. 빠져 있으면
// 연결 단계 실패가 풀 안의 즉시 재시도를 못 받고 세션 백오프로 바로 넘어간다.
const NETWORK_TEXT = /econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|request timed out|connection error|\bterminated\b|other side closed/i;
const FAIL_FAST_TEXT = /context[ _-]?(?:length|window)|maximum context|invalid[ _-]?model|model[ _-]?not[ _-]?found|malformed[ _-]?stream|premature[ _-]?(?:close|stream)/i;
const ABORT_TEXT = /\baborted?\b/i;

function errorStatus(error) {
  if (typeof error?.status === "number") return error.status;
  if (typeof error?.statusCode === "number") return error.statusCode;
  if (typeof error?.cause?.status === "number") return error.cause.status;
  if (typeof error?.cause?.statusCode === "number") return error.cause.statusCode;
  const text = error instanceof Error ? error.message : String(error ?? "");
  const match = text.match(/\b(401|402|403|429|500|502|503|529)\b/);
  return match ? Number(match[1]) : undefined;
}

function errorText(error) {
  if (error instanceof Error) {
    const extra = error.errorMessage ?? error.body ?? "";
    return extra ? `${error.message} ${extra}` : error.message;
  }
  return String(error ?? "");
}

/**
 * 한도 초과(429) 응답이 알려 주는 "다시 돼도 되는 때"까지 남은 ms. 모르면 `undefined`.
 *
 * `retry-after-ms`·`retry-after`(초 또는 HTTP 날짜)가 먼저고, 없으면 Anthropic 구독 한도의
 * `anthropic-ratelimit-unified-reset`(유닉스 초)을 쓴다. `headers` 는 `Headers` 든 평범한
 * 객체든 받는다.
 */
export function serverRetryAfterMs(headers, now = Date.now()) {
  if (!headers) return undefined;
  const get = (name) => {
    const value = typeof headers.get === "function" ? headers.get(name) : headers[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const retryAfterMs = Number.parseFloat(get("retry-after-ms") ?? "");
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  const retryAfter = get("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms)) return Math.max(0, ms);
  }
  const resetSeconds = Number(get("anthropic-ratelimit-unified-reset") ?? "");
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) return Math.max(0, resetSeconds * 1_000 - now);
  return undefined;
}

/**
 * 한도 초과로 계정을 얼마나 쉬게 할지.
 *
 * 서버가 풀리는 때를 알려 주면 그 값을 그대로 쓴다. 지수 백오프는 서버가 말이 없을 때만이다.
 * 실측(2026-10-13): 서버 값을 버리고 60s × 2^실패횟수로만 셌더니 실패 19번째에 상한 48h 에
 * 닿아, 몇 시간 만에 풀린 구독 한도를 이틀 동안 잠갔다. 그동안 그 계정에 묶인 모델은 이유도
 * 없이 "Account 'setup-token' is unavailable" 로만 실패했다.
 */
export function rateLimitCooldown(failureCount, serverHintMs, policy = {}) {
  const cap = policy.capMs ?? COOLDOWN_CAP_MS;
  const base = policy.baseMs ?? COOLDOWN_BASE_MS;
  const wanted = serverHintMs === undefined
    ? base * 2 ** Math.max(0, failureCount)
    : Math.max(1_000, serverHintMs);
  return {
    cooldownMs: Math.min(cap, wanted),
    retryAfterWasCapped: serverHintMs !== undefined && wanted > cap,
  };
}

export function classifyCredentialFailure(error, context = {}) {
  const text = errorText(error);
  const status = errorStatus(error);
  const failureCount = context.failureCount ?? 0;
  if ((error instanceof Error && error.name === "AbortError") || ABORT_TEXT.test(text)) {
    return { kind: "fail_request" };
  }
  if (status === 401 || INVALID_KEY_TEXT.test(text)) {
    return { kind: "failover", block: { reason: "auth_error" } };
  }
  if (status === 403) {
    return ACCOUNT_SCOPED_403_TEXT.test(text)
      ? { kind: "failover", block: { reason: "auth_error" } }
      : { kind: "fail_request" };
  }
  if (FAST_MODE_CREDITS_TEXT.test(text)) {
    return { kind: "fail_request" };
  }
  if (status === 402 || BILLING_TEXT.test(text)) {
    return { kind: "failover", block: { reason: "account_disabled" } };
  }
  if (status === 429 || RATE_LIMIT_TEXT.test(text)) {
    return {
      kind: "failover",
      block: {
        reason: "rate_limit",
        ...rateLimitCooldown(failureCount, context.serverRetryAfterMs, {
          baseMs: context.cooldownBaseMs,
          capMs: context.cooldownCapMs,
        }),
      },
    };
  }
  if (status === 400 || status === 404 || FAIL_FAST_TEXT.test(text)) {
    return { kind: "fail_request" };
  }
  if (status === 529 || OVERLOAD_TEXT.test(text) || (status !== undefined && status >= 500 && status < 600)) {
    return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
  }
  if (status === 408 || NETWORK_TEXT.test(text)) {
    return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
  }
  return { kind: "fail_request" };
}
