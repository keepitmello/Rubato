import { PRODUCT_MODEL_ORDER } from "../model-core/product-model-catalog.mjs";

/**
 * Image generation runs on the ChatGPT login only: the Codex backend's Responses endpoint with
 * the `image_generation` server tool. API keys, gateways and the OpenAI Images API are never used,
 * so every guard below fails closed instead of falling back.
 */
export const CODEX_PROVIDER = "openai-codex";
const CODEX_HOST = "chatgpt.com";

/** The picker lists the Codex flagship first; images follow it, so a retired model leaves with its picker row. */
export const ORCHESTRATOR_MODEL_ID = PRODUCT_MODEL_ORDER[CODEX_PROVIDER][0];

/** ChatGPT Images 2.5 tiers: Flare is the fast everyday tier, Sunburst the precise-editing tier. */
export const IMAGE_MODELS = Object.freeze({
    create: "gpt-image-2.5-flare",
    edit: "gpt-image-2.5-sunburst",
});

export const LOGIN_REASON = "Image generation runs only on the OpenAI ChatGPT login. Run /login and choose OpenAI (ChatGPT Plus/Pro). API keys and gateways are never used.";

const INSTRUCTIONS = [
    "You turn the user's request into exactly one image by calling the image_generation tool once.",
    "Keep the requested subject, text, layout and style; do not add elements the user did not ask for.",
    "Attached images are the source to edit or the reference to follow.",
].join(" ");

function hostOf(baseUrl) {
    try {
        return new URL(baseUrl).hostname;
    }
    catch {
        return undefined;
    }
}

/** Resolves the Codex model that drives the image tool, or the reason it cannot run. */
export function resolveCodexImageModel(registry) {
    const model = registry?.find?.(CODEX_PROVIDER, ORCHESTRATOR_MODEL_ID);
    if (model === undefined) {
        return { ok: false, reason: `Image generation needs ${CODEX_PROVIDER}/${ORCHESTRATOR_MODEL_ID}, which is not in the model registry.` };
    }
    if (hostOf(model.baseUrl) !== CODEX_HOST) {
        return { ok: false, reason: `${CODEX_PROVIDER} points at ${model.baseUrl}; image generation only calls https://${CODEX_HOST}.` };
    }
    if (registry.isUsingOAuth?.(model) !== true) {
        return { ok: false, reason: LOGIN_REASON };
    }
    return { ok: true, model };
}

/** The server tool entry for one call. `auto` values are left to the backend. */
export function imageGenerationTool({ imageModel, size, quality }) {
    return {
        type: "image_generation",
        model: imageModel,
        output_format: "png",
        ...(size === "auto" ? {} : { size }),
        ...(quality === "auto" ? {} : { quality }),
    };
}

/** Earlier requests in an edit chain ride along as text so the edit keeps their intent. */
export function composePrompt(prompt, history) {
    if (history.length === 0)
        return prompt;
    const earlier = history.map((turn, index) => `${index + 1}. ${turn.prompt}`).join("\n");
    return `Earlier requests that produced the attached image, oldest first:\n${earlier}\n\nNow apply this request to the attached image:\n${prompt}`;
}

function readCompletedImage(block) {
    if (block?.type !== "providerNative" || block.subtype !== "image_generation_call")
        return undefined;
    const raw = block.raw;
    if (raw?.status !== "completed" || typeof raw.result !== "string" || raw.result.length === 0)
        return undefined;
    return {
        data: raw.result,
        ...(typeof raw.revised_prompt === "string" && raw.revised_prompt.trim() ? { revisedPrompt: raw.revised_prompt.trim() } : {}),
    };
}

/**
 * Runs one image call through the session's model registry, which owns the OAuth token,
 * its refresh and the Codex headers.
 */
export async function generateCodexImage({ registry, model, imageModel, prompt, images, size, quality, signal }) {
    const userMessage = {
        role: "user",
        content: [{ type: "text", text: prompt }, ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))],
        timestamp: Date.now(),
    };
    const message = await registry.complete(model, { systemPrompt: INSTRUCTIONS, messages: [userMessage] }, {
        ...(signal === undefined ? {} : { signal }),
        cacheRetention: "none",
        onPayload: (body) => ({
            ...body,
            tools: [imageGenerationTool({ imageModel, size, quality })],
            tool_choice: "auto",
            parallel_tool_calls: false,
        }),
    });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
        return { ok: false, reason: "provider_error", message: message.errorMessage ?? `Image generation ${message.stopReason}.` };
    }
    const image = message.content.map(readCompletedImage).find((candidate) => candidate !== undefined);
    if (image === undefined) {
        const said = message.content.filter((block) => block.type === "text").map((block) => block.text.trim()).filter(Boolean).join("\n");
        return { ok: false, reason: "no_image", message: said ? `The model returned no image: ${said}` : "The model returned no image." };
    }
    return { ok: true, ...image, ...(message.usage === undefined ? {} : { usage: message.usage }) };
}
