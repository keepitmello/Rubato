export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_CAP_MS = 48 * 60 * 60 * 1_000;
export const RETRY_SAME_MAX_ATTEMPTS = 2;
export const TURN_RETRY_SUPPRESSION_PREFIX = "senpi:no-turn-retry:";

const INVALID_KEY_TEXT = /invalid[ _-]?(?:api[ _-]?)?key|authentication[_ ]?error|invalid x-api-key|unauthorized/i;
const ACCOUNT_SCOPED_403_TEXT = /account|credential|token|api[ _-]?key|organization|subscription/i;
const RATE_LIMIT_TEXT = /rate[ _-]?limit|too many requests|resource_exhausted/i;
const BILLING_TEXT = /billing|credits?[ _-]?(?:required|exhausted|balance)|insufficient[ _-]?(?:funds|quota|credit)|payment[ _-]?required|quota[ _-]?exhausted/i;
const OVERLOAD_TEXT = /overloaded/i;
const NETWORK_TEXT = /econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|request timed out/i;
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

export function rateLimitCooldown(failureCount, serverHintMs, policy = {}) {
  const cap = policy.capMs ?? COOLDOWN_CAP_MS;
  const base = policy.baseMs ?? COOLDOWN_BASE_MS;
  const backoff = Math.min(cap, base * 2 ** Math.max(0, failureCount));
  const floored = serverHintMs === undefined ? backoff : Math.max(backoff, serverHintMs);
  return {
    cooldownMs: Math.min(cap, floored),
    retryAfterWasCapped: floored > cap,
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
  if (status === 402 || BILLING_TEXT.test(text)) {
    return { kind: "failover", block: { reason: "account_disabled" } };
  }
  if (status === 429 || RATE_LIMIT_TEXT.test(text)) {
    return {
      kind: "failover",
      block: {
        reason: "rate_limit",
        ...rateLimitCooldown(failureCount, undefined, {
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
