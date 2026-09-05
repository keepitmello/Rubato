// License-preserved extract of getToolCallFormat / shouldRecoverTextToolCalls
// from @earendil-works/pi-ai@2026.9.4-3 (senpi nested, MIT),
// originally dist/tool-call-middleware/index.js. Not a wholesale package copy.
export function getToolCallFormat(model) {
    if (model.api !== "openai-completions") {
        return undefined;
    }
    const compat = model.compat;
    const format = compat?.toolCallFormat;
    if (!format) {
        return undefined;
    }
    if (format === "hermes" ||
        format === "xml" ||
        format === "morph-xml" ||
        format === "yaml-xml" ||
        format === "gemma4-delimiter" ||
        format === "anthropic-xml" ||
        format === "antml" ||
        format === "kimi-xtml") {
        return format;
    }
    return undefined;
}
export function shouldRecoverTextToolCalls(model) {
    if (getToolCallFormat(model) !== undefined)
        return false;
    if (model.recoverTextToolCalls !== undefined) {
        return typeof model.recoverTextToolCalls === "boolean" ? model.recoverTextToolCalls : false;
    }
    if (model.api === "cursor-agent")
        return false;
    return CLAUDE_MODEL_ID_PATTERN.test(model.id) || KIMI_MODEL_ID_PATTERN.test(model.id);
}
const CLAUDE_MODEL_ID_PATTERN = /(^|[^a-z0-9])claude([^a-z0-9]|$)/i;
const KIMI_MODEL_ID_PATTERN = /(^|[^a-z0-9])kimi([^a-z0-9]|$)/i;
/**
 * Whether the model leaks Kimi XTML channel markers when tool calling fails,
 * selecting the XTML recovery parser over the default invoke recovery parser.
 */
