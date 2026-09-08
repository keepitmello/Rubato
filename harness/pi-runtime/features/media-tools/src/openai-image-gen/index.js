import { resolveImageGenAuth } from "../imagegen/auth.js";
import { imageGenRegistryOverride, setNativeBypass } from "../imagegen/state.js";
import { externalizeNativeImages } from "./externalize.js";
import { isOpenAiImageGenEnabled, nativeImageGenModelKey, supportsNativeOpenAiImageGeneration, } from "./gate.js";
import { applyImageGenerationTools } from "./inject.js";

export { isOpenAiImageGenEnabled, supportsNativeOpenAiImageGeneration } from "./gate.js";
export { applyImageGenerationTools, NATIVE_IMAGE_GEN_TOOL_TYPE } from "./inject.js";

export const OPENAI_IMAGE_GEN_SECTION = `
## Image Generation

Native image generation is available in this session.
Generate images with the built-in image_generation tool instead of a client-side tool.
`;

const UNKNOWN_MODEL_REASON = "No model is selected, so image generation availability is unknown.";

async function resolveState(model, ctx) {
    const modelKey = nativeImageGenModelKey(model);
    if (model === undefined) {
        return { kind: "unavailable", modelKey, reason: UNKNOWN_MODEL_REASON };
    }
    if (supportsNativeOpenAiImageGeneration(model) && isOpenAiImageGenEnabled()) {
        return { kind: "native", modelKey, source: model.baseUrl };
    }
    const auth = await resolveImageGenAuth({ modelRegistry: imageGenRegistryOverride() ?? ctx.modelRegistry });
    if (auth.kind !== "none") {
        return { kind: "client", modelKey, source: `${auth.provenance}:${auth.providerId ?? auth.kind}` };
    }
    return { kind: "unavailable", modelKey, reason: auth.reason };
}

export default function openaiImageGenExtension(pi) {
    let state = { kind: "unavailable", modelKey: "", reason: UNKNOWN_MODEL_REASON };
    async function refresh(model, ctx) {
        state = await resolveState(model, ctx);
        setNativeBypass(state.kind === "native");
    }
    async function ensureFresh(model, ctx) {
        if (nativeImageGenModelKey(model) !== state.modelKey) {
            await refresh(model, ctx);
        }
    }
    pi.on("session_start", async (_event, ctx) => {
        await refresh(ctx.model, ctx);
    });
    pi.on("model_select", async (event, ctx) => {
        await refresh(event.model, ctx);
    });
    pi.on("before_provider_request", async (event, ctx) => {
        const model = event.model ?? ctx.model;
        await ensureFresh(model, ctx);
        return applyImageGenerationTools(event.payload, state.kind);
    });
    pi.on("before_agent_start", async (event, ctx) => {
        await ensureFresh(ctx.model, ctx);
        if (state.kind !== "native")
            return undefined;
        return { systemPrompt: `${event.systemPrompt}\n${OPENAI_IMAGE_GEN_SECTION}` };
    });
    pi.on("message_end", async (event, ctx) => {
        if (event.message.role !== "assistant")
            return undefined;
        const message = await externalizeNativeImages(event.message, ctx.cwd);
        return message === undefined ? undefined : { message };
    });
    pi.on("session_shutdown", async () => {
        setNativeBypass(false);
    });
}
