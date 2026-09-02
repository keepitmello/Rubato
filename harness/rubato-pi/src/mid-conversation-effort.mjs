// Mid-conversation effort: freeze top-level `output_config.effort` and carry
// Shift+Tab changes as empty-content system messages so the prompt-cache prefix
// (`params` + earlier `messages`) stays byte-stable.
//
// Official (2026-07-28): beta `mid-conversation-output-config-2026-07-01`;
// `{ role: "system", content: [], output_config: { effort } }` inside `messages`
// takes effect from the next user turn. Intercept at the fetch boundary after
// `buildParams` / `sanitizeAdaptiveThinkingPayload` — no engine source patch.

import { createHash } from "node:crypto";

export const MID_CONVERSATION_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";

export const MID_CONVERSATION_EFFORT_MODELS = Object.freeze([
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-opus-5",
]);

const MODEL_SET = new Set(MID_CONVERSATION_EFFORT_MODELS);

export function isMidConversationEffortModel(modelId) {
  return MODEL_SET.has(modelId);
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Drop `cache_control` so the last-message 1h breakpoint does not look like compaction. */
export function stableMessageFingerprint(value) {
  if (Array.isArray(value)) return value.map(stableMessageFingerprint);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "cache_control") continue;
    out[key] = stableMessageFingerprint(nested);
  }
  return out;
}

/** model id + stable hash of `messages[0]`. A model switch or compaction changes it. */
export function effortLineage(modelId, messages) {
  return `${modelId}\n${sha(JSON.stringify(stableMessageFingerprint(messages?.[0] ?? null)))}`;
}

export function headersToRecord(headers) {
  const record = {};
  if (!headers) return record;
  const iterable = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
  for (const [key, value] of iterable) {
    if (value === undefined || value === null) continue;
    record[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return record;
}

function effortOf(body) {
  const effort = body?.output_config?.effort;
  return typeof effort === "string" && effort.length > 0 ? effort : undefined;
}

function messagesUrl(url) {
  return /\/v1\/messages(\?|$)/.test(url);
}

/**
 * Gate. Fail-closed: anything else is a no-op so we never rewrite a body the
 * API would reject (Fable 5, Kiro, Bedrock, Vertex, Antigravity, …).
 */
export function shouldRewriteMidConversationEffort({ body, provider }) {
  return provider === "anthropic"
    && isMidConversationEffortModel(body?.model)
    && effortOf(body) !== undefined;
}

function lastEffectiveEffort(state) {
  return state.marks.at(-1)?.effort ?? state.baseEffort;
}

function marksOutOfRange(marks, length) {
  // Insert points are "just before" an existing original message, so an index
  // at or past `length` cannot be placed without emitting a trailing system
  // message. Treat that as history shrink without a lineage change.
  return marks.some((mark) => !Number.isInteger(mark.index) || mark.index < 0 || mark.index >= length);
}

/**
 * Per-session transition. `previous` is missing/empty or lineage-mismatched →
 * re-anchor. Otherwise a level change appends a mark at `messages.length - 1`.
 */
export function nextEffortSessionState(previous, { model, messages, effort }) {
  const length = Array.isArray(messages) ? messages.length : 0;
  const lineage = effortLineage(model, messages);
  const empty = !previous || previous.lineage == null || previous.baseEffort == null;
  const reset = empty
    || previous.lineage !== lineage
    || marksOutOfRange(previous.marks ?? [], length);
  if (reset) {
    return { lineage, baseEffort: effort, marks: [] };
  }
  if (effort !== lastEffectiveEffort(previous) && length > 0) {
    return {
      lineage: previous.lineage,
      baseEffort: previous.baseEffort,
      marks: [...previous.marks, { index: length - 1, effort }],
    };
  }
  return previous;
}

/**
 * Freeze top-level effort and insert one empty system message per mark.
 * Indices refer to the original `messages` array; insert high-to-low so
 * earlier messages stay the same objects (same JSON bytes).
 */
export function rewriteEffortBody(body, state) {
  if (body?.output_config && typeof body.output_config === "object") {
    body.output_config.effort = state.baseEffort;
  }
  if (!Array.isArray(body.messages) || state.marks.length === 0) return body;
  const messages = body.messages.slice();
  for (const mark of [...state.marks].sort((a, b) => b.index - a.index)) {
    messages.splice(mark.index, 0, {
      role: "system",
      content: [],
      output_config: { effort: mark.effort },
    });
  }
  body.messages = messages;
  return body;
}

/**
 * Append the mid-conversation beta. Never replaces an existing `anthropic-beta`
 * value — OAuth already bakes `claude-code-20250219,oauth-2025-04-20`.
 */
export function appendMidConversationEffortBeta(headers) {
  const beta = MID_CONVERSATION_EFFORT_BETA;
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

function requestUrl(input) {
  if (typeof input === "string") return input;
  return input?.href ?? input?.url ?? String(input);
}

export function applyMidConversationEffort(bodyText, headers, { provider, sessionId, store }) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { bodyText, headers, rewritten: false };
  }
  if (!shouldRewriteMidConversationEffort({ body, provider })) {
    return { bodyText, headers, rewritten: false };
  }
  const key = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "anonymous";
  const state = nextEffortSessionState(store.get(key), {
    model: body.model,
    messages: body.messages,
    effort: effortOf(body),
  });
  store.set(key, state);
  if (state.marks.length === 0 && body.output_config?.effort === state.baseEffort) {
    return { bodyText, headers, rewritten: false, state };
  }
  rewriteEffortBody(body, state);
  return {
    bodyText: JSON.stringify(body),
    headers: state.marks.length > 0 ? appendMidConversationEffortBeta(headers) : headers,
    rewritten: true,
    state,
  };
}

export function wrapMidConversationEffortFetch(baseFetch, { sessionId, provider, store } = {}) {
  if (!store) throw new TypeError("wrapMidConversationEffortFetch needs a store");
  const inner = baseFetch ?? globalThis.fetch;
  return async (input, init = {}) => {
    const url = requestUrl(input);
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    if (!messagesUrl(url) || bodyText === undefined) return inner(input, init);
    const applied = applyMidConversationEffort(bodyText, init.headers, { provider, sessionId, store });
    if (!applied.rewritten) return inner(input, init);
    return inner(input, { ...init, body: applied.bodyText, headers: applied.headers });
  };
}

export function createMidConversationEffort({ store = new Map() } = {}) {
  return {
    store,
    wrapFetch(baseFetch, meta = {}) {
      return wrapMidConversationEffortFetch(baseFetch, { ...meta, store });
    },
  };
}

let shared;
export function midConversationEffort() {
  shared ??= createMidConversationEffort();
  return shared;
}
