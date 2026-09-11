import {
  ANTHROPIC_SERVER_COMPACTION_BETA,
  ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE,
  anthropicServerCompactionArmed,
  supportsAnthropicServerCompaction,
} from "./anthropic-server-compaction.mjs";
import { COMPACTION_BRIEFING_GUIDANCE } from "./guidance.mjs";

let warnedDisarmed = false;
function warnDisarmedOnce() {
  if (warnedDisarmed) return;
  warnedDisarmed = true;
  process.emitWarning(
    "Anthropic server compaction stays off: adapter/lane transforms did not apply (pinned needle drift?)",
    { code: "RUBATO_SERVER_COMPACTION_DISARMED" },
  );
}

function messagesUrl(url) {
  return /\/v1\/messages(\?|$)/.test(url);
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  return input?.href ?? input?.url ?? String(input);
}

/**
 * `anthropic-beta` 에 compact 베타를 덧붙인다. 기존 값을 바꾸지 않는다 —
 * OAuth 가 이미 `claude-code-20250219,oauth-2025-04-20` 을 구워 둔다.
 */
export function appendAnthropicServerCompactionBeta(headers) {
  const beta = ANTHROPIC_SERVER_COMPACTION_BETA;
  if (headers && typeof headers.get === "function" && typeof headers.set === "function") {
    const current = headers.get("anthropic-beta") ?? "";
    const listed = current.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (listed.includes(beta)) return headers;
    const next = new Headers(headers);
    next.set("anthropic-beta", current ? `${current},${beta}` : beta);
    return next;
  }
  const record = headers && typeof headers === "object" ? { ...headers } : {};
  const key = Object.keys(record).find((name) => name.toLowerCase() === "anthropic-beta");
  const current = key ? String(record[key]) : "";
  const listed = current.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (listed.includes(beta)) return headers ?? record;
  if (key) record[key] = `${record[key]},${beta}`;
  else record["anthropic-beta"] = beta;
  return record;
}

export function shouldRewriteAnthropicServerCompaction({ body, provider }) {
  return supportsAnthropicServerCompaction({
    provider,
    id: typeof body?.model === "string" ? body.model : undefined,
  });
}

/** 컨텍스트 창 중 이만큼 찼을 때 서버 컴팩션을 돌린다 (= 35% 남았을 때). */
export const ANTHROPIC_SERVER_COMPACTION_TRIGGER_RATIO = 0.65;
/** Anthropic 이 허용하는 trigger 최소값. */
export const ANTHROPIC_SERVER_COMPACTION_TRIGGER_MIN = 50_000;

/**
 * Anthropic 기본 trigger 는 150k 라서 1M 창에서는 15% 만 쓰고 압축된다. 모델의
 * contextWindow 를 알면 그 65% 지점을 trigger 로 보낸다. 모르면 undefined (기본값에 맡김).
 */
export function anthropicServerCompactionTrigger(contextWindow) {
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) return undefined;
  const value = Math.max(ANTHROPIC_SERVER_COMPACTION_TRIGGER_MIN, Math.floor(window * ANTHROPIC_SERVER_COMPACTION_TRIGGER_RATIO));
  return { type: "input_tokens", value };
}

/**
 * 기존 `context_management` 는 유지하고 `compact_20260112` edit 만 합친다.
 * `instructions` 는 클라이언트 컴팩션과 같은 인계 지침(`compaction-guidance.mjs`) — Anthropic 기본
 * 프롬프트를 완전히 대체한다. pause_after_compaction 은 넣지 않는다 (기본값).
 * trigger 는 contextWindow 를 알 때만 붙는다.
 */
export function mergeAnthropicServerCompactionEdit(body, { contextWindow } = {}) {
  const edit = { type: ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE, instructions: COMPACTION_BRIEFING_GUIDANCE };
  const trigger = anthropicServerCompactionTrigger(contextWindow);
  if (trigger) edit.trigger = trigger;
  const existing = body.context_management;
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    body.context_management = { edits: [edit] };
    return body;
  }
  const edits = Array.isArray(existing.edits) ? existing.edits.slice() : [];
  if (!edits.some((entry) => entry && entry.type === ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE)) {
    edits.push(edit);
  }
  body.context_management = { ...existing, edits };
  return body;
}

export function applyAnthropicServerCompaction(bodyText, headers, { provider, contextWindow, armed = anthropicServerCompactionArmed() } = {}) {
  if (!armed) {
    warnDisarmedOnce();
    return { bodyText, headers, rewritten: false };
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { bodyText, headers, rewritten: false };
  }
  if (!shouldRewriteAnthropicServerCompaction({ body, provider })) {
    return { bodyText, headers, rewritten: false };
  }
  const before = bodyText;
  mergeAnthropicServerCompactionEdit(body, { contextWindow });
  const nextHeaders = appendAnthropicServerCompactionBeta(headers);
  const nextBody = JSON.stringify(body);
  const rewritten = nextBody !== before || nextHeaders !== headers;
  return { bodyText: nextBody, headers: nextHeaders, rewritten };
}

export function wrapAnthropicServerCompactionFetch(baseFetch, { provider, contextWindow, armed } = {}) {
  const inner = baseFetch ?? globalThis.fetch;
  return async (input, init = {}) => {
    const url = requestUrl(input);
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    if (!messagesUrl(url) || bodyText === undefined) return inner(input, init);
    const applied = applyAnthropicServerCompaction(bodyText, init.headers, { provider, contextWindow, ...(armed === undefined ? {} : { armed }) });
    if (!applied.rewritten) return inner(input, init);
    return inner(input, { ...init, body: applied.bodyText, headers: applied.headers });
  };
}

/** Mutate a stock Anthropic Messages params object the same way the fetch wrap rewrites the wire body. */
export function applyAnthropicServerCompactionParams(params, model, { armed = true } = {}) {
  if (!armed || !params || typeof params !== "object") return params;
  if (!supportsAnthropicServerCompaction(model)) return params;
  const next = { ...params };
  mergeAnthropicServerCompactionEdit(next, { contextWindow: model?.contextWindow });
  const betas = Array.isArray(next.betas) ? next.betas.slice() : [];
  if (!betas.includes(ANTHROPIC_SERVER_COMPACTION_BETA)) betas.push(ANTHROPIC_SERVER_COMPACTION_BETA);
  next.betas = betas;
  return next;
}
