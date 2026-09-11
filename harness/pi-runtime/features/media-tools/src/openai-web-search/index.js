const OPENAI_RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses"]);
const ENABLE_ENV = "PI_OPENAI_WEB_SEARCH";
const NATIVE_OPENAI_WEB_SEARCH_TYPE = "web_search_preview";
const WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";
const STATUS_KEY = "openai-web-search";
const WIDGET_KEY = "openai-web-search";

function parseEnableEnv(envVar) {
    const envValue = process.env[envVar];
    if (!envValue) {
        return true;
    }
    const normalized = envValue.trim().toLowerCase();
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
        return false;
    }
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
        return true;
    }
    return true;
}

function isRecord(value) {
    return typeof value === "object" && value !== null;
}

function isOpenAiResponsesApi(api) {
    return api !== undefined && OPENAI_RESPONSES_APIS.has(api);
}

function resolveTarget(target) {
    if (target === undefined) {
        return undefined;
    }
    if (typeof target === "string") {
        return { api: target, baseUrl: target === "openai-responses" ? "https://api.openai.com/v1" : "" };
    }
    return target;
}

function isOpenAiResponsesNativeEndpoint(model) {
    try {
        return new URL(model.baseUrl || "https://api.openai.com/v1").hostname === "api.openai.com";
    }
    catch {
        return false;
    }
}

export function supportsNativeOpenAiWebSearch(target) {
    const model = resolveTarget(target);
    if (!isOpenAiResponsesApi(model?.api)) {
        return false;
    }
    if (model.api === "azure-openai-responses") {
        return true;
    }
    const compat = model.compat;
    return compat?.supportsWebSearchPreview ?? isOpenAiResponsesNativeEndpoint(model);
}

function isNativeOpenAiWebSearchType(value) {
    return value === "web_search_preview" || value === "web_search_preview_2025_03_11";
}

function isUnsupportedWebSearchType(value) {
    return (typeof value === "string" &&
        (value === "web_search" || value.startsWith("web_search_")) &&
        !isNativeOpenAiWebSearchType(value));
}

function isAnthropicWebFetchType(value) {
    return typeof value === "string" && value.startsWith("web_fetch_");
}

function stripNativeOpenAiWebSearch(payload) {
    if (!isRecord(payload)) {
        return payload;
    }
    let changed = false;
    const sanitized = { ...payload };
    const tools = payload.tools;
    if (Array.isArray(tools)) {
        const sanitizedTools = tools.filter((tool) => !(isRecord(tool) && isNativeOpenAiWebSearchType(tool.type)));
        if (sanitizedTools.length !== tools.length) {
            changed = true;
            sanitized.tools = sanitizedTools;
        }
    }
    const include = payload.include;
    if (Array.isArray(include)) {
        const sanitizedInclude = include.filter((value) => value !== WEB_SEARCH_SOURCES_INCLUDE);
        if (sanitizedInclude.length !== include.length) {
            changed = true;
            sanitized.include = sanitizedInclude;
        }
    }
    if (isRecord(payload.tool_choice) && isNativeOpenAiWebSearchType(payload.tool_choice.type)) {
        changed = true;
        delete sanitized.tool_choice;
    }
    return changed ? sanitized : payload;
}

function sanitizeTools(tools, options) {
    const sanitized = [];
    let changed = false;
    for (const tool of tools) {
        if (!isRecord(tool)) {
            changed = true;
            continue;
        }
        const type = tool.type;
        const shouldStripFunctionVariant = options.stripFunctionWebSearch && tool.name === "web_search" && !isNativeOpenAiWebSearchType(type);
        const shouldStripProviderNativeVariant = isUnsupportedWebSearchType(type) || isAnthropicWebFetchType(type);
        if (shouldStripFunctionVariant || shouldStripProviderNativeVariant) {
            changed = true;
        }
        else {
            sanitized.push(tool);
        }
    }
    return { changed, tools: sanitized };
}

function includeWebSearchSources(payload) {
    const include = Array.isArray(payload.include)
        ? payload.include.filter((value) => typeof value === "string")
        : [];
    return include.includes(WEB_SEARCH_SOURCES_INCLUDE) ? include : [...include, WEB_SEARCH_SOURCES_INCLUDE];
}

export function addOpenAiWebSearchToPayload(target, payload) {
    const model = resolveTarget(target);
    if (!isOpenAiResponsesApi(model?.api)) {
        return stripNativeOpenAiWebSearch(payload);
    }
    if (!isRecord(payload)) {
        return payload;
    }
    const supportsNativeWebSearch = supportsNativeOpenAiWebSearch(model);
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const shouldInjectWebSearch = supportsNativeWebSearch && isOpenaiWebSearchEnabled();
    const strippedPayload = supportsNativeWebSearch ? payload : stripNativeOpenAiWebSearch(payload);
    if (!isRecord(strippedPayload)) {
        return strippedPayload;
    }
    const strippedTools = Array.isArray(strippedPayload.tools) ? strippedPayload.tools : [];
    const activeTools = supportsNativeWebSearch ? tools : strippedTools;
    const sanitized = sanitizeTools(tools, { stripFunctionWebSearch: shouldInjectWebSearch });
    const sanitizedTools = sanitized.tools;
    if (!shouldInjectWebSearch) {
        const nativeStripped = strippedPayload !== payload;
        const passiveSanitized = sanitizeTools(activeTools, { stripFunctionWebSearch: false });
        if (!nativeStripped && !passiveSanitized.changed) {
            return strippedPayload;
        }
        return {
            ...strippedPayload,
            tools: passiveSanitized.tools,
        };
    }
    const hasNativeWebSearch = sanitizedTools.some((tool) => isNativeOpenAiWebSearchType(tool.type));
    if (!hasNativeWebSearch) {
        sanitizedTools.push({ type: NATIVE_OPENAI_WEB_SEARCH_TYPE });
    }
    return {
        ...payload,
        tools: sanitizedTools,
        include: includeWebSearchSources(payload),
    };
}

export function isOpenaiWebSearchEnabled() {
    return parseEnableEnv(ENABLE_ENV);
}

function clearUi(ctx) {
    if (!ctx.hasUI)
        return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function syncUi(ctx) {
    clearUi(ctx);
}

export const OPENAI_WEB_SEARCH_SECTION = `
## Web Search

Native web search is available in this session.
Use web search when the user asks for current or online information.
Prefer web search over guessing when freshness matters.
`;

function readString(record, key) {
    const value = record?.[key];
    return typeof value === "string" ? value : undefined;
}

export function formatOpenAiWebSearchText(raw) {
    if (!isRecord(raw) || raw.type !== "web_search_call") return undefined;
    const action = isRecord(raw.action) ? raw.action : {};
    const query = readString(action, "query");
    const queries = Array.isArray(action.queries) ? action.queries.filter((value) => typeof value === "string") : [];
    const sources = Array.isArray(action.sources) ? action.sources.filter(isRecord) : [];
    const lines = [];
    const shownQuery = query ?? queries[0];
    if (shownQuery) lines.push(`Web search: ${shownQuery}`);
    else lines.push("Web search");
    for (const source of sources) {
        const title = readString(source, "title") ?? readString(source, "name");
        const url = readString(source, "url") ?? readString(source, "uri");
        if (title && url) lines.push(`- ${title} ${url}`);
        else if (url) lines.push(`- ${url}`);
        else if (title) lines.push(`- ${title}`);
    }
    return lines.join("\n");
}

export function materializeOpenAiWebSearch(message) {
    if (!Array.isArray(message.content)) return undefined;
    const content = [];
    let replaced = false;
    for (const block of message.content) {
        if (block.type !== "providerNative" || block.subtype !== "web_search_call") {
            content.push(block);
            continue;
        }
        const text = formatOpenAiWebSearchText(block.raw);
        if (text === undefined) {
            content.push(block);
            continue;
        }
        content.push({ type: "text", text });
        replaced = true;
    }
    return replaced ? { ...message, content } : undefined;
}

export default function openaiWebSearchExtension(pi) {
    pi.on("before_provider_request", (event, ctx) => {
        return addOpenAiWebSearchToPayload(ctx.model, event.payload);
    });
    pi.on("session_start", async (_event, ctx) => {
        syncUi(ctx);
    });
    pi.on("model_select", async (_event, ctx) => {
        syncUi(ctx);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        clearUi(ctx);
    });
    pi.on("before_agent_start", async (event, ctx) => {
        if (!supportsNativeOpenAiWebSearch(ctx.model)) {
            return undefined;
        }
        if (!isOpenaiWebSearchEnabled()) {
            return undefined;
        }
        return {
            systemPrompt: `${event.systemPrompt}\n${OPENAI_WEB_SEARCH_SECTION}`,
        };
    });
    pi.on("message_end", async (event) => {
        if (event.message.role !== "assistant") return undefined;
        const message = materializeOpenAiWebSearch(event.message);
        return message === undefined ? undefined : { message };
    });
}
