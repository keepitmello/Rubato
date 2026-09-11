const OPENAI_BASE_URL = "https://api.openai.com/v1";
const SETUP_REASON = 'Image generation is not configured. Store an OpenAI API key for provider "openai", configure an OpenAI-compatible gateway in models.json and optionally pin it with PI_IMAGE_GEN_PROVIDER, or set OPENAI_API_KEY.';
function nonEmpty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function resolvedHeaders(headers) {
    if (!headers)
        return undefined;
    const resolved = {};
    for (const [name, value] of Object.entries(headers)) {
        if (typeof value === "string" && value.trim().length > 0)
            resolved[name] = value;
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
}
/**
 * Seeded placeholder keys (`SK-SENTINEL-DO-NOT-LOG-*`) are not credentials. Left unfiltered, such a
 * value satisfies the stored-openai branch, pins `api.openai.com`, and every request 401s with
 * `Incorrect API key provided: SK-SENTI***OG-2` while a working gateway sits unused.
 */
function isPlaceholderKey(apiKey) {
    return /^SK-SENTINEL-DO-NOT-LOG/i.test(apiKey);
}
function credentialParts(auth) {
    const apiKey = nonEmpty(auth?.apiKey);
    if (!apiKey || isPlaceholderKey(apiKey))
        return undefined;
    const headers = resolvedHeaders(auth?.headers);
    return { apiKey, ...(headers ? { headers } : {}) };
}
function hasStoredApiKey(registry, provider) {
    return registry.getProviderAuthStatus(provider)?.source === "stored";
}
function isGatewayApi(api) {
    return api === "openai-completions" || api === "openai-responses";
}
function compareText(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function compareProviderIds(left, right) {
    const leftMatches = /openai/i.test(left);
    const rightMatches = /openai/i.test(right);
    if (leftMatches !== rightMatches)
        return leftMatches ? -1 : 1;
    return compareText(left, right);
}
function groupGatewayModels(models) {
    const groups = new Map();
    const ordered = [...models].sort((left, right) => compareText(left.provider, right.provider) || compareText(left.id, right.id));
    for (const model of ordered) {
        if (model.provider === "openai" || !isGatewayApi(model.api) || !nonEmpty(model.baseUrl))
            continue;
        if (!groups.has(model.provider))
            groups.set(model.provider, model);
    }
    return groups;
}
async function resolveStoredOpenAi(registry) {
    if (!hasStoredApiKey(registry, "openai"))
        return undefined;
    let resolved;
    try {
        resolved = await registry.getProviderAuth("openai");
    }
    catch {
        return undefined;
    }
    const credentials = credentialParts(resolved?.auth);
    if (!credentials)
        return undefined;
    return {
        kind: "native-openai",
        ...credentials,
        baseUrl: OPENAI_BASE_URL,
        provenance: "store",
        providerId: "openai",
    };
}
async function resolveGateway(providerId, model, registry) {
    const baseUrl = nonEmpty(model.baseUrl);
    if (!baseUrl)
        return undefined;
    let resolved;
    try {
        resolved = await registry.getApiKeyAndHeaders(model);
    }
    catch {
        return undefined;
    }
    if (!resolved.ok)
        return undefined;
    const credentials = credentialParts(resolved);
    if (!credentials)
        return undefined;
    return {
        kind: "gateway",
        ...credentials,
        baseUrl,
        provenance: "provider-config",
        providerId,
    };
}
export async function resolveImageGenAuth(deps) {
    const native = await resolveStoredOpenAi(deps.modelRegistry);
    if (native)
        return native;
    const groups = groupGatewayModels(deps.modelRegistry.getAll());
    const env = deps.env ?? process.env;
    const pinnedProvider = nonEmpty(env.PI_IMAGE_GEN_PROVIDER);
    if (pinnedProvider) {
        const pinnedModel = groups.get(pinnedProvider);
        if (pinnedModel) {
            const pinned = await resolveGateway(pinnedProvider, pinnedModel, deps.modelRegistry);
            if (pinned)
                return pinned;
        }
    }
    const providerIds = [...groups.keys()]
        .filter((providerId) => providerId !== pinnedProvider)
        .sort(compareProviderIds);
    for (const providerId of providerIds) {
        const model = groups.get(providerId);
        if (!model)
            continue;
        const gateway = await resolveGateway(providerId, model, deps.modelRegistry);
        if (gateway)
            return gateway;
    }
    const envApiKey = nonEmpty(env.OPENAI_API_KEY);
    if (envApiKey && !isPlaceholderKey(envApiKey)) {
        return {
            kind: "native-openai",
            apiKey: envApiKey,
            baseUrl: OPENAI_BASE_URL,
            provenance: "env",
        };
    }
    return { kind: "none", reason: SETUP_REASON };
}
