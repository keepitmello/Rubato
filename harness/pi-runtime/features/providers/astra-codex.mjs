import { ASTRA_CODEX_PRELUDE } from "../../../rubato-pi/src/transforms/misc-astra-codex.mjs";

function replaceOnce(source, before, after, label) {
	const first = source.indexOf(before);
	if (first === -1) throw new Error(`[astra-codex:${label}] expected anchor is missing`);
	if (source.indexOf(before, first + before.length) !== -1) {
		throw new Error(`[astra-codex:${label}] expected anchor is ambiguous`);
	}
	return source.slice(0, first) + after + source.slice(first + before.length);
}

const BUILD_NEEDLE = `function buildRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties = createGrammarToolInputProperties(context.tools, model.compat?.supportsOpenAIGrammarTools ?? false)) {`;

const TEMP_NEEDLE = `    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }`;

const TEMP_REPLACEMENT = `    // Rubato: Astra lists temperature/top_p as unsupported — never send it.
    // Other models keep the passthrough below.
    if (options?.temperature !== undefined && !isAstraConfigurationUpdateModel(model)) {
        body.temperature = options.temperature;
    }`;

const REASON_NEEDLE = `        if (effort !== null) {
            body.reasoning = {
                effort,
                summary: options.reasoningSummary ?? "auto",
            };
        }
    }
    return body;
}`;

const REASON_REPLACEMENT = `        if (effort !== null) {
            body.reasoning = {
                effort,
                summary: options.reasoningSummary ?? "auto",
            };
        }
    }
    applyAstraConfigurationUpdate(body, model, cacheSessionId, options?.reasoningEffort);
    return body;
}`;

const WS_NEEDLE = `            const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
                includeSystemPrompt: false,
                grammarToolInputProperties,
            }).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");`;

const WS_REPLACEMENT = `            const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
                includeSystemPrompt: false,
                preserveThinking: !!fullBody.reasoning,
                preserveTextSignatures: true,
                grammarToolInputProperties,
            }).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");`;

export function patchOpenAiCodexResponsesAstra(source) {
	let next = replaceOnce(source, BUILD_NEEDLE, `${ASTRA_CODEX_PRELUDE}${BUILD_NEEDLE}`, "helpers");
	next = replaceOnce(next, TEMP_NEEDLE, TEMP_REPLACEMENT, "temperature");
	next = replaceOnce(next, REASON_NEEDLE, REASON_REPLACEMENT, "configuration-update");
	next = replaceOnce(next, WS_NEEDLE, WS_REPLACEMENT, "ws-thinking");
	next = replaceOnce(
		next,
		"const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;",
		"const SESSION_WEBSOCKET_CACHE_TTL_MS = 30 * 60 * 1000;",
		"ws-ttl",
	);
	return replaceOnce(
		next,
		"    }, SESSION_WEBSOCKET_CACHE_TTL_MS);",
		"    }, SESSION_WEBSOCKET_CACHE_TTL_MS);\n    entry.idleTimer.unref?.();",
		"ws-ttl-unref",
	);
}

export function patchTransformMessagesPreserve(source) {
	let next = replaceOnce(
		source,
		"export function transformMessages(messages, model, normalizeToolCallId) {",
		"export function transformMessages(messages, model, normalizeToolCallId, options = {}) {",
		"options-arg",
	);
	next = replaceOnce(
		next,
		"    if (model.input.includes(\"image\")) {",
		"    if (model.input?.includes(\"image\")) {",
		"input-guard",
	);
	next = replaceOnce(
		next,
		"    const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);\n    // First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)",
		`    const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);
    const preserveThinking = options.preserveThinking ?? true;
    const preserveTextSignatures = options.preserveTextSignatures ?? false;
    // First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)`,
		"preserve-flags",
	);
	next = replaceOnce(
		next,
		`            const isSameModel = assistantMsg.provider === model.provider &&
                assistantMsg.api === model.api &&
                assistantMsg.model === model.id;
            const transformedContent = assistantMsg.content.flatMap((block) => {`,
		`            const isSameModel = assistantMsg.provider === model.provider &&
                assistantMsg.api === model.api &&
                assistantMsg.model === model.id;
            const hasToolCalls = assistantMsg.content.some((block) => block.type === "toolCall");
            const preserveProviderState = preserveThinking || hasToolCalls;
            const transformedContent = assistantMsg.content.flatMap((block) => {`,
		"preserve-provider-state",
	);
	next = replaceOnce(
		next,
		`                    if (isSameModel && block.thinkingSignature)
                        return block;
                    // Skip empty thinking blocks, convert others to plain text
                    if (!block.thinking || block.thinking.trim() === "")
                        return [];
                    if (isSameModel)
                        return block;`,
		`                    const hasUsableSignature = typeof block.thinkingSignature === "string" && block.thinkingSignature.trim().length > 0;
                    if (isSameModel && hasUsableSignature && (preserveProviderState || block.thinking.trim() === ""))
                        return block;
                    // Skip empty thinking blocks, convert others to plain text
                    if (!block.thinking || block.thinking.trim() === "")
                        return [];
                    if (isSameModel)
                        return preserveProviderState ? block : [];`,
		"thinking-preserve",
	);
	return replaceOnce(
		next,
		`                if (block.type === "text") {
                    if (isSameModel)
                        return block;
                    return {
                        type: "text",
                        text: block.text,
                    };
                }`,
		`                if (block.type === "text") {
                    if (isSameModel && (preserveProviderState || preserveTextSignatures))
                        return block;
                    return {
                        type: "text",
                        text: block.text,
                    };
                }`,
		"text-signatures",
	);
}
