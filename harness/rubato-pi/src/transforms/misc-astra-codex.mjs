// Astra-only effort rewrite + Codex WS continuation serialize.
// OpenAI: keep request-level reasoning.effort frozen and place
// `configuration_update` before the turn it applies to; replay that item
// at the same index. Moving it rewrites the prompt-cache prefix.
// https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation
// Unknown backends fail closed by model id. Astra rejects temperature.

// The engine patch that splices this prelude in lives in
// harness/pi-runtime/features/providers/astra-codex.mjs. Unit tests `new Function` it.
export const ASTRA_CODEX_PRELUDE = `// Rubato: Astra mid-conversation effort without breaking the prompt cache.
// Request-level body.reasoning.effort stays at the session's first value.
// Each effort change is a mark at input.length-1 (last item — a new user
// turn, or the last tool/assistant if Shift+Tab lands mid-loop). Marks are
// replayed at those indices so later appends stay a prefix.
const astraConfigurationUpdateState = new Map();
function isAstraConfigurationUpdateModel(model) {
    return !!model && (model.id === "gpt-6-astra" || model.upstreamModelId === "gpt-6-astra");
}
function astraMarksOutOfRange(marks, length) {
    return marks.some((mark) => !Number.isInteger(mark.index) || mark.index < 0 || mark.index >= length);
}
function applyAstraConfigurationUpdate(body, model, cacheSessionId, reasoningEffort) {
    if (!isAstraConfigurationUpdateModel(model)) return body;
    if (reasoningEffort === undefined || reasoningEffort === null) return body;
    if (!body || !Array.isArray(body.input)) return body;
    const key = (model.id || "unknown") + "\\n" + (cacheSessionId || "anonymous");
    const length = body.input.length;
    let state = astraConfigurationUpdateState.get(key);
    const reset = !state
        || body.input.length < state.lastInputLength
        || astraMarksOutOfRange(state.marks ?? [], length);
    if (reset) {
        state = { base: reasoningEffort, lastInputLength: length, marks: [] };
        astraConfigurationUpdateState.set(key, state);
    }
    state.lastInputLength = length;
    if (body.reasoning && typeof body.reasoning === "object") {
        body.reasoning = Object.assign({}, body.reasoning, { effort: state.base });
    }
    const lastEffort = state.marks.length > 0 ? state.marks[state.marks.length - 1].effort : state.base;
    if (reasoningEffort !== lastEffort && length > 0) {
        const index = length - 1;
        const last = state.marks[state.marks.length - 1];
        if (last && last.index === index) {
            state.marks = state.marks.slice(0, -1).concat([{ index: index, effort: reasoningEffort }]);
        }
        else {
            state.marks = state.marks.concat([{ index: index, effort: reasoningEffort }]);
        }
    }
    if (state.marks.length === 0) return body;
    const next = body.input.slice();
    for (const mark of state.marks.slice().sort((a, b) => b.index - a.index)) {
        next.splice(mark.index, 0, { type: "configuration_update", reasoning: { effort: mark.effort } });
    }
    body.input = next;
    return body;
}
`;
