// Fable 5.1 / Opus 5 / Sonnet 5 official thinking.display default is "omitted".
// pi-ai still sends "summarized" for supportsMidConvoEffort models so the
// summaries stream as thinking_delta and the TUI paints them as visible prose
// next to the Thinking... label. That is not a Claude SSE mis-parse — session
// jsonl already keeps thinking vs text apart. Rewrite at the fetch boundary
// after buildParams, same seam as mid-conversation-effort.
//
// https://platform.claude.com/docs/en/build-with-claude/thinking#controlling-thinking-display
// https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1

export const OMITTED_THINKING_DISPLAY_MODELS = Object.freeze([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-mythos-5-1",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-mythos-preview",
]);

const MODEL_RE = /(?:^|[./])(claude-(?:fable|mythos)-5(?:-1)?|claude-(?:opus|sonnet)-5|claude-opus-4-[78]|claude-mythos-preview)(?:-|$)/;

export function isOmittedThinkingDisplayModel(modelId) {
  return MODEL_RE.test(String(modelId ?? ""));
}

function messagesUrl(url) {
  return /\/v1\/messages(\?|$)/.test(url);
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  return input?.href ?? input?.url ?? String(input);
}

/**
 * Gate. Fail-closed: unknown provider / model / body is a no-op so we never
 * rewrite a request the API would reject.
 */
export function shouldRewriteThinkingDisplay({ body, provider }) {
  return provider === "anthropic"
    && isOmittedThinkingDisplayModel(body?.model)
    && body?.thinking
    && typeof body.thinking === "object"
    && body.thinking.display === "summarized";
}

export function rewriteThinkingDisplay(body) {
  if (!body?.thinking || typeof body.thinking !== "object") return body;
  body.thinking.display = "omitted";
  return body;
}

export function applyThinkingDisplay(bodyText, { provider } = {}) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { bodyText, rewritten: false };
  }
  if (!shouldRewriteThinkingDisplay({ body, provider })) {
    return { bodyText, rewritten: false };
  }
  rewriteThinkingDisplay(body);
  return { bodyText: JSON.stringify(body), rewritten: true };
}

export function wrapThinkingDisplayFetch(baseFetch, { provider } = {}) {
  const inner = baseFetch ?? globalThis.fetch;
  return async (input, init = {}) => {
    const url = requestUrl(input);
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    if (!messagesUrl(url) || bodyText === undefined) return inner(input, init);
    const applied = applyThinkingDisplay(bodyText, { provider });
    if (!applied.rewritten) return inner(input, init);
    return inner(input, { ...init, body: applied.bodyText });
  };
}
