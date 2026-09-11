import { GENERATE_IMAGE_TOOL_NAME } from "../imagegen/tool.js";

export const NATIVE_IMAGE_GEN_TOOL_TYPE = "image_generation";

function isRecord(value) {
    return typeof value === "object" && value !== null;
}

function isNativeImageGenTool(tool) {
    if (!isRecord(tool))
        return false;
    const type = tool.type;
    return (typeof type === "string" &&
        (type === NATIVE_IMAGE_GEN_TOOL_TYPE || type.startsWith(`${NATIVE_IMAGE_GEN_TOOL_TYPE}_`)));
}

/** Matches the client tool by name rather than by `type`. */
function isGenerateImageFunctionTool(tool) {
    return isRecord(tool) && tool.name === GENERATE_IMAGE_TOOL_NAME;
}

/** Enforces mutual exclusion between client and Responses-native image tools. */
export function applyImageGenerationTools(payload, mode) {
    if (!isRecord(payload))
        return payload;
    const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
    const stripFunctionTool = mode !== "client";
    const kept = (tools ?? []).filter((tool) => !isNativeImageGenTool(tool) && !(stripFunctionTool && isGenerateImageFunctionTool(tool)));
    const removed = (tools?.length ?? 0) !== kept.length;
    if (mode !== "native") {
        return removed ? { ...payload, tools: kept } : payload;
    }
    return { ...payload, tools: [...kept, { type: NATIVE_IMAGE_GEN_TOOL_TYPE }] };
}
