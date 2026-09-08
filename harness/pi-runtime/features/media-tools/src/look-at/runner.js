import { loadLookAtInputs } from "./image-input.js";
import { resolveVisionModel } from "./model-selector.js";
import { buildLookAtUserMessage, LOOK_AT_SYSTEM_PROMPT } from "./prompts.js";
import { loadLookAtChain } from "./settings.js";
const LOOK_AT_TIMEOUT_MS = 120_000;
export async function runLookAt(args, signal, ctx, store, dependencies = {}) {
    throwIfAborted(signal);
    const inputs = await loadLookAtInputs(ctx, inputPaths(args), inputData(args));
    const resolved = resolveVisionModel(loadLookAtChain(ctx, store), ctx.modelRegistry.getAvailable());
    if (!resolved) {
        throw new Error("No image-capable model is available. Configure a vision-capable provider and try look_at again.");
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
    if (!auth.ok) {
        throw new Error(`look_at cannot use ${resolved.model.provider}/${resolved.model.id}: ${auth.error}. ` +
            `Configure credentials with /login ${resolved.model.provider} and try again.`);
    }
    throwIfAborted(signal);
    const request = createRequestSignal(signal);
    try {
        const userMessage = {
            role: "user",
            content: [
                ...inputs.map(toImageBlock),
                {
                    type: "text",
                    text: buildLookAtUserMessage(args.goal, inputs.map((input) => input.label)),
                },
            ],
            timestamp: Date.now(),
        };
        const complete = dependencies.complete ??
            ((model, context, options) => ctx.modelRegistry.complete(model, context, options));
        const reasoning = toStreamReasoning(resolved.thinkingLevel);
        const response = await complete(resolved.model, { systemPrompt: LOOK_AT_SYSTEM_PROMPT, messages: [userMessage] }, {
            ...(reasoning === undefined ? {} : { reasoning }),
            maxTokens: 4096,
            signal: request.signal,
        });
        return {
            model: `${resolved.model.provider}/${resolved.model.id}`,
            sources: inputs.map((input) => input.label),
            mimeTypes: inputs.map((input) => input.mimeType),
            text: responseText(response, request.signal),
        };
    }
    catch (error) {
        if (request.signal.aborted)
            throw new Error("look_at analysis was aborted.");
        throw error;
    }
    finally {
        request.dispose();
    }
}
function inputPaths(args) {
    return args.file_paths ?? (args.file_path ? [args.file_path] : []);
}
function inputData(args) {
    return args.image_data_list ?? (args.image_data ? [args.image_data] : []);
}
function toImageBlock(input) {
    return { type: "image", data: input.data, mimeType: input.mimeType };
}
function responseText(response, signal) {
    if (response.stopReason === "error") {
        const providerMessage = response.errorMessage ?? "The vision provider returned an unspecified error.";
        throw new Error(`Vision model failed to analyze the supplied media: ${providerMessage}`);
    }
    if (response.stopReason === "aborted" || signal.aborted) {
        throw new Error("look_at analysis was aborted.");
    }
    const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    if (!text) {
        throw new Error("Vision model returned no analysis text. Try a clearer goal or another image.");
    }
    return text;
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new Error("look_at analysis was aborted.");
}
function toStreamReasoning(level) {
    if (level === undefined || level === "off")
        return undefined;
    return level;
}
function createRequestSignal(signal) {
    const controller = new AbortController();
    const abortFromTool = () => controller.abort(signal?.reason);
    if (signal?.aborted)
        abortFromTool();
    else
        signal?.addEventListener("abort", abortFromTool, { once: true });
    const timeout = setTimeout(() => controller.abort(), LOOK_AT_TIMEOUT_MS);
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abortFromTool);
        },
    };
}
//# sourceMappingURL=runner.js.map
