import OpenAI from "openai";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.js";
import { headersToRecord } from "../utils/headers.js";
import { retryProviderRequest } from "../utils/provider-retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { resolveOpenAIClientAuth } from "./openai-client-auth.js";
const MAX_PROMPT_CHARS = 32_000;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const ENDPOINT_SUFFIXES = ["/chat/completions", "/responses", "/models"];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50];
export const generateImages = async (model, context, options) => {
    const output = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [],
        stopReason: "stop",
        timestamp: Date.now(),
    };
    try {
        let params = buildParams(model, context, options);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
            if (!isGenerateParams(nextParams))
                throw new Error("onPayload returned an invalid image generation payload");
            params = nextParams;
        }
        const headers = { ...model.headers, ...options?.headers };
        const auth = resolveOpenAIClientAuth(model.provider, options?.apiKey, headers);
        const client = new OpenAI({
            apiKey: auth.apiKey,
            baseURL: normalizeBaseUrl(model.baseUrl),
            dangerouslyAllowBrowser: true,
            fetch: options?.fetch,
            defaultHeaders: auth.headers,
        });
        const requestOptions = {
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
            maxRetries: 0,
        };
        const { data: response, response: rawResponse } = await retryProviderRequest(() => client.images.generate(params, requestOptions).withResponse(), {
            maxRetries: options?.maxRetries,
            maxRetryDelayMs: options?.maxRetryDelayMs,
            signal: options?.signal,
        });
        await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);
        if (response.usage)
            output.usage = parseUsage(response.usage, model);
        if (!response.data || response.data.length === 0)
            throw new Error("OpenAI images response contained no image data");
        for (const datum of response.data) {
            const image = await resolveImage(datum, options);
            if (datum.revised_prompt?.trim()) {
                output.output.push({ type: "text", text: datum.revised_prompt });
            }
            output.output.push(image);
        }
        return output;
    }
    catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = formatProviderError(normalizeProviderError(error));
        return output;
    }
};
function buildParams(model, context, options) {
    const promptParts = [];
    for (const item of context.input) {
        if (item.type === "image") {
            throw new Error("generations does not accept image input; use the images edit endpoint");
        }
        const text = sanitizeSurrogates(item.text);
        if (text.trim())
            promptParts.push(text);
    }
    const prompt = promptParts.join("\n\n");
    if (!prompt.trim())
        throw new Error("Image generation requires a non-empty text prompt");
    if (prompt.length > MAX_PROMPT_CHARS) {
        throw new Error(`Image generation prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    return {
        model: model.id,
        prompt,
        size: options?.size ?? "auto",
        quality: options?.quality ?? "auto",
        n: options?.n ?? 1,
        output_format: "png",
        stream: false,
    };
}
function isGenerateParams(value) {
    return typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string";
}
function normalizeBaseUrl(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        throw new Error(`Invalid OpenAI images base URL: ${baseUrl}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("OpenAI images base URL must use HTTP or HTTPS");
    }
    if (url.search || url.hash)
        throw new Error("OpenAI images base URL must not include a query or fragment");
    const pathname = url.pathname.replace(/\/+$/, "");
    const normalizedPathname = pathname.toLowerCase();
    if (normalizedPathname.includes("/images")) {
        throw new Error("OpenAI images base URL must not include an images endpoint");
    }
    if (ENDPOINT_SUFFIXES.some((suffix) => normalizedPathname.endsWith(suffix))) {
        throw new Error("OpenAI images base URL must not include a known API endpoint");
    }
    url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
    return url.toString();
}
async function resolveImage(datum, options) {
    const b64 = datum.b64_json?.trim();
    if (b64)
        return { type: "image", mimeType: "image/png", data: b64 };
    const url = datum.url?.trim();
    if (!url)
        throw new Error("OpenAI images response datum contained no image data");
    if (url.startsWith("data:"))
        return parseDataUrl(url);
    return hydrateImageUrl(url, options);
}
function parseDataUrl(url) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
    if (!match?.[1] || !match[2])
        throw new Error("OpenAI images response contained an invalid data URL");
    const mimeType = supportedMime(match[1]);
    if (!mimeType)
        throw new Error(`OpenAI images response used unsupported MIME type: ${match[1]}`);
    return { type: "image", mimeType, data: match[2] };
}
async function hydrateImageUrl(url, options) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error("OpenAI images response URL must be absolute");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("OpenAI images response URL must use HTTP or HTTPS");
    }
    const response = await (options?.fetch ?? globalThis.fetch)(url, options?.signal ? { signal: options.signal } : {});
    if (!response.ok)
        throw new Error(`OpenAI image hydration failed with HTTP ${response.status}`);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > MAX_IMAGE_BYTES)
        throw oversizedImageError();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0)
        throw new Error("OpenAI image hydration returned an empty body");
    if (bytes.byteLength > MAX_IMAGE_BYTES)
        throw oversizedImageError();
    const declaredMime = supportedMime(response.headers.get("content-type")?.split(";", 1)[0]);
    const detectedMime = detectMime(bytes);
    if (declaredMime && detectedMime && declaredMime !== detectedMime) {
        throw new Error(`OpenAI image MIME mismatch: declared ${declaredMime}, detected ${detectedMime}`);
    }
    const mimeType = detectedMime ?? declaredMime;
    if (!mimeType)
        throw new Error("OpenAI image hydration returned unsupported image content");
    return { type: "image", mimeType, data: bytesToBase64(bytes) };
}
function supportedMime(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp")
        return normalized;
    return undefined;
}
function detectMime(bytes) {
    if (hasMagic(bytes, PNG_MAGIC))
        return "image/png";
    if (hasMagic(bytes, JPEG_MAGIC))
        return "image/jpeg";
    if (hasMagic(bytes, WEBP_MAGIC.slice(0, 4)) && hasMagic(bytes, WEBP_MAGIC.slice(4), 8))
        return "image/webp";
    return undefined;
}
function hasMagic(bytes, magic, offset = 0) {
    return magic.every((value, index) => bytes[offset + index] === value);
}
function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}
function oversizedImageError() {
    return new Error("OpenAI image hydration exceeded the 24 MiB limit");
}
function parseUsage(rawUsage, model) {
    const input = rawUsage.input_tokens ?? 0;
    const output = rawUsage.output_tokens ?? 0;
    const usage = {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: rawUsage.total_tokens ?? input + output,
        cost: {
            input: (model.cost.input / 1_000_000) * input,
            output: (model.cost.output / 1_000_000) * output,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
    usage.cost.total = usage.cost.input + usage.cost.output;
    return usage;
}
