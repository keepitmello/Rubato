import { arch, platform, release } from "node:os";
import { PRODUCT_MODEL_ORDER } from "../model-core/product-model-catalog.mjs";

/**
 * Image generation runs on the ChatGPT login only: the Codex backend's own image endpoints
 * (`/codex/images/generations` and `/codex/images/edits`, the routes Codex CLI calls). No chat
 * model sits in between, so the prompt reaches the image service exactly as written. API keys,
 * gateways and the public OpenAI Images API are never used; every guard fails closed.
 */
export const CODEX_PROVIDER = "openai-codex";
const CODEX_HOST = "chatgpt.com";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 300_000;

/** The ChatGPT login is read through the picker's Codex flagship row; that model is never called. */
export const AUTH_MODEL_ID = PRODUCT_MODEL_ORDER[CODEX_PROVIDER][0];

/** ChatGPT Images 2.5 tiers: Flare is the fast everyday tier, Sunburst the precise-editing tier. */
export const IMAGE_MODELS = Object.freeze({
    create: "gpt-image-2.5-flare",
    edit: "gpt-image-2.5-sunburst",
});

export const LOGIN_REASON = "Image generation runs only on the OpenAI ChatGPT login. Run /login and choose OpenAI (ChatGPT Plus/Pro). API keys and gateways are never used.";

function hostOf(baseUrl) {
    try {
        return new URL(baseUrl).hostname;
    }
    catch {
        return undefined;
    }
}

/** Resolves the Codex model whose login the image request borrows, or the reason it cannot run. */
export function resolveCodexImageModel(registry) {
    const model = registry?.find?.(CODEX_PROVIDER, AUTH_MODEL_ID);
    if (model === undefined) {
        return { ok: false, reason: `Image generation needs the ${CODEX_PROVIDER}/${AUTH_MODEL_ID} login, which is not in the model registry.` };
    }
    if (hostOf(model.baseUrl) !== CODEX_HOST) {
        return { ok: false, reason: `${CODEX_PROVIDER} points at ${model.baseUrl}; image generation only calls https://${CODEX_HOST}.` };
    }
    if (registry.isUsingOAuth?.(model) !== true) {
        return { ok: false, reason: LOGIN_REASON };
    }
    return { ok: true, model };
}

/** `https://chatgpt.com/backend-api[/codex[/responses]]` → `https://chatgpt.com/backend-api/codex/images/<kind>`. */
export function imageEndpoint(baseUrl, kind) {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/codex(\/responses)?$/, "");
    return `${root}/codex/images/${kind}`;
}

/** The request body. `auto` values are left to the backend. */
export function imageRequestBody({ imageModel, prompt, images, size, quality }) {
    return {
        model: imageModel,
        prompt,
        n: 1,
        output_format: "png",
        ...(size === "auto" ? {} : { size }),
        ...(quality === "auto" ? {} : { quality }),
        ...(images.length === 0 ? {} : { images: images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })) }),
    };
}

/** Earlier requests in an edit chain ride along as text so the edit keeps their intent. */
export function composePrompt(prompt, history) {
    if (history.length === 0)
        return prompt;
    const earlier = history.map((turn, index) => `${index + 1}. ${turn.prompt}`).join("\n");
    return `Earlier requests that produced the attached image, oldest first:\n${earlier}\n\nNow apply this request to the attached image:\n${prompt}`;
}

function accountIdOf(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        const id = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
        return typeof id === "string" && id.length > 0 ? id : undefined;
    }
    catch {
        return undefined;
    }
}

function toUsage(usage) {
    if (typeof usage?.input_tokens !== "number" || typeof usage?.output_tokens !== "number")
        return undefined;
    return {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usage.input_tokens + usage.output_tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

/** Turns a non-2xx reply into a failure the agent can act on; moderation blocks are named as such. */
function describeFailure(status, body) {
    const error = body?.error;
    if (error?.code === "moderation_blocked") {
        const details = error.moderation_details ?? {};
        const categories = Array.isArray(details.categories) && details.categories.length > 0 ? details.categories.join(", ") : "unspecified";
        const stage = typeof details.moderation_stage === "string" ? details.moderation_stage : "unspecified";
        return { ok: false, reason: "moderation_blocked", message: `The image service's safety system rejected the prompt (stage: ${stage}; categories: ${categories}). The prompt was sent exactly as written; nothing rewrote it.` };
    }
    const detail = typeof error?.message === "string" ? error.message : typeof body?.detail === "string" ? body.detail : undefined;
    return { ok: false, reason: "provider_error", message: `Image service returned HTTP ${status}${detail ? `: ${detail}` : "."}` };
}

/**
 * Sends one image request on the session's ChatGPT login. The registry owns the OAuth token and
 * its refresh; the account id comes from the token itself, as the Codex provider reads it.
 */
export async function generateCodexImage({ registry, model, imageModel, prompt, images, size, quality, signal, fetch = globalThis.fetch }) {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || typeof auth.apiKey !== "string" || auth.apiKey.length === 0) {
        return { ok: false, reason: "missing_config", message: auth.ok ? LOGIN_REASON : `${auth.error} ${LOGIN_REASON}` };
    }
    const accountId = accountIdOf(auth.apiKey);
    if (accountId === undefined) {
        return { ok: false, reason: "missing_config", message: `The ChatGPT login token carries no account id. ${LOGIN_REASON}` };
    }
    const kind = images.length === 0 ? "generations" : "edits";
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(imageEndpoint(model.baseUrl, kind), {
            method: "POST",
            headers: {
                ...auth.headers,
                Authorization: `Bearer ${auth.apiKey}`,
                "chatgpt-account-id": accountId,
                originator: "pi",
                "User-Agent": `pi (${platform()} ${release()}; ${arch()})`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(imageRequestBody({ imageModel, prompt, images, size, quality })),
            signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
    }
    catch (error) {
        if (signal?.aborted)
            return { ok: false, reason: "provider_error", message: "Image generation aborted." };
        if (timeout.aborted)
            return { ok: false, reason: "provider_error", message: `Image service did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.` };
        return { ok: false, reason: "provider_error", message: `Image request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        body = undefined;
    }
    if (!response.ok) {
        return body === undefined
            ? { ok: false, reason: "provider_error", message: `Image service returned HTTP ${response.status}: ${text.slice(0, 200).trim()}` }
            : describeFailure(response.status, body);
    }
    const data = body?.data?.[0]?.b64_json;
    if (typeof data !== "string" || data.length === 0) {
        return { ok: false, reason: "no_image", message: "The image service returned no image." };
    }
    const usage = toUsage(body.usage);
    return { ok: true, data, ...(usage === undefined ? {} : { usage }) };
}
