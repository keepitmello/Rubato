import { replaceOnce } from "./misc-replace.mjs";

// Astra-only: request-level reasoning stays frozen for the prompt-cache
// prefix; Shift+Tab effort changes travel as `configuration_update` input
// items. OpenAI documents the item for HTTP Responses and WebSocket
// `response.create`; it changes only reasoning effort, only on GPT-6 Astra,
// standard single-agent. Unknown backends fail closed by model id, never by
// request shape. `temperature` is unsupported on Astra, so it never goes out.

// Exported for unit tests: `new Function` the prelude to reach the helpers.
export const ASTRA_CODEX_PRELUDE = `// Rubato: Astra mid-conversation effort without breaking the prompt cache.
// The request-level body.reasoning.effort stays at the session's first value
// so the WebSocket cached-context delta still matches; effort changes travel
// as configuration_update input items before the newest user message.
const astraConfigurationUpdateState = new Map();
function isAstraConfigurationUpdateModel(model) {
    return !!model && (model.id === "gpt-6-astra" || model.upstreamModelId === "gpt-6-astra");
}
function applyAstraConfigurationUpdate(body, model, cacheSessionId, reasoningEffort) {
    if (!isAstraConfigurationUpdateModel(model)) return body;
    if (reasoningEffort === undefined || reasoningEffort === null) return body;
    if (!body || !Array.isArray(body.input)) return body;
    const key = (model.id || "unknown") + "\\n" + (cacheSessionId || "anonymous");
    let state = astraConfigurationUpdateState.get(key);
    if (!state || body.input.length < state.lastInputLength) {
        state = { base: reasoningEffort, lastInputLength: body.input.length };
        astraConfigurationUpdateState.set(key, state);
    }
    state.lastInputLength = body.input.length;
    if (body.reasoning && typeof body.reasoning === "object") {
        body.reasoning = Object.assign({}, body.reasoning, { effort: state.base });
    }
    if (reasoningEffort === state.base) return body;
    const update = { type: "configuration_update", reasoning: { effort: reasoningEffort } };
    let at = body.input.length;
    for (let i = body.input.length - 1; i >= 0; i--) {
        if (body.input[i] && body.input[i].role === "user") { at = i; break; }
    }
    body.input = body.input.slice(0, at).concat([update], body.input.slice(at));
    return body;
}
`;

const SIG_NEEDLE = `function buildRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties = createGrammarToolInputProperties(context.tools, model.compat?.supportsOpenAIGrammarTools ?? false)) {`;

const TEMP_NEEDLE = `    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }`;

const TEMP_REPLACEMENT = `    // Rubato: Astra lists temperature/top_p as unsupported — never send it.
    // Other models keep the passthrough below.
    if (options?.temperature !== undefined && !isAstraConfigurationUpdateModel(model)) {
        body.temperature = options.temperature;
    }`;

const REASON_NEEDLE = `    const reasoning = buildCodexReasoning(reasoningEffort, options?.reasoningSummary, model.reasoning, model.thinkingLevelMap?.off);
    if (reasoning)
        body.reasoning = reasoning;
    applyExtraBody(body, options?.extraBody, OPENAI_RESPONSES_RESERVED_BODY_KEYS);
    return body;`;

const REASON_REPLACEMENT = `    const reasoning = buildCodexReasoning(reasoningEffort, options?.reasoningSummary, model.reasoning, model.thinkingLevelMap?.off);
    if (reasoning)
        body.reasoning = reasoning;
    applyAstraConfigurationUpdate(body, model, cacheSessionId, reasoningEffort);
    applyExtraBody(body, options?.extraBody, OPENAI_RESPONSES_RESERVED_BODY_KEYS);
    return body;`;

export function isAstraCodexUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/openai-codex-responses.js");
}

/**
 * Astra mid-conversation effort + temperature strip on the Codex Responses
 * wire. Non-Astra models pass through byte-identical.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectAstraCodex(source) {
  let next = replaceOnce(source, SIG_NEEDLE, `${ASTRA_CODEX_PRELUDE}${SIG_NEEDLE}`, "astra-codex helpers");
  next = replaceOnce(next, TEMP_NEEDLE, TEMP_REPLACEMENT, "astra-codex temperature");
  return replaceOnce(next, REASON_NEEDLE, REASON_REPLACEMENT, "astra-codex configuration-update");
}
