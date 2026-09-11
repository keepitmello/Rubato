import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const featureDir = dirname(fileURLToPath(import.meta.url));

function replaceOnce(source, before, after, label) {
	const first = source.indexOf(before);
	if (first === -1) throw new Error(`[media-tools:${label}] expected anchor is missing`);
	if (source.indexOf(before, first + before.length) !== -1) {
		throw new Error(`[media-tools:${label}] expected anchor is ambiguous`);
	}
	return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchOpenAiResponsesShared(source) {
	let next = replaceOnce(
		source,
		`export async function processResponsesStream(openaiStream, output, stream, model, options) {`,
		`const MAX_NATIVE_IMAGE_BASE64_CHARS = 24 * 1024 * 1024;
function readNativeImageGenerationCall(value) {
    if (typeof value !== "object" || value === null || !("type" in value) || !("status" in value))
        return undefined;
    if (value.type !== "image_generation_call" || typeof value.status !== "string")
        return undefined;
    return {
        type: "image_generation_call",
        ...("id" in value && typeof value.id === "string" ? { id: value.id } : {}),
        status: value.status,
        ...("result" in value && (typeof value.result === "string" || value.result === null)
            ? { result: value.result }
            : {}),
        ...("revised_prompt" in value && typeof value.revised_prompt === "string"
            ? { revised_prompt: value.revised_prompt }
            : {}),
    };
}
function isValidBase64(value) {
    return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
function reconcileNativeImageGenerationCall(item) {
    if (item.status !== "completed") {
        return {
            type: "image_generation_call",
            ...(item.id !== undefined ? { id: item.id } : {}),
            status: item.status,
        };
    }
    if (typeof item.result !== "string" || !isValidBase64(item.result)) {
        return {
            type: "image_generation_call",
            ...(item.id !== undefined ? { id: item.id } : {}),
            status: "malformed",
        };
    }
    return {
        type: "image_generation_call",
        ...(item.id !== undefined ? { id: item.id } : {}),
        status: "completed",
        result: item.result,
        ...(item.revised_prompt?.trim() ? { revised_prompt: item.revised_prompt } : {}),
    };
}
export async function processResponsesStream(openaiStream, output, stream, model, options) {`,
		"native-image-helpers",
	);
	next = replaceOnce(
		next,
		`    let sawTerminalResponseEvent = false;
    const outputSlots = new Map();
    const reasoningBlocksById = new Map();`,
		`    let sawTerminalResponseEvent = false;
    let nativeImageBase64Chars = 0;
    const outputSlots = new Map();
    const reasoningBlocksById = new Map();
    const nativeImageCharsByOutputIndex = new Map();
    const finalizedNativeImageOutputIndexes = new Set();`,
		"native-image-state",
	);
	next = replaceOnce(
		next,
		`            return slot;
        }
        return undefined;
    };
    const getOrCreateSlot = (outputIndex, item) => {
        return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
    };`,
		`            return slot;
        }
        const imageItem = readNativeImageGenerationCall(item);
        const block = {
            type: "providerNative",
            subtype: item.type,
            raw: imageItem ? reconcileNativeImageGenerationCall(imageItem) : item,
        };
        const slot = {
            type: "providerNative",
            block,
            contentIndex: output.content.length,
        };
        if (imageItem)
            reconcileNativeImageSlot(outputIndex, slot, imageItem);
        output.content.push(block);
        outputSlots.set(outputIndex, slot);
        return slot;
    };
    const getOrCreateSlot = (outputIndex, item) => {
        return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
    };
    function scrubNativeImageResults() {
        for (const block of output.content) {
            if (block.type !== "providerNative" || block.subtype !== "image_generation_call")
                continue;
            const item = readNativeImageGenerationCall(block.raw);
            if (typeof item?.result !== "string")
                continue;
            block.raw = {
                type: "image_generation_call",
                ...(item.id !== undefined ? { id: item.id } : {}),
                status: "malformed",
            };
        }
        nativeImageBase64Chars = 0;
        nativeImageCharsByOutputIndex.clear();
    }
    function reconcileNativeImageSlot(outputIndex, slot, item) {
        const reconciled = reconcileNativeImageGenerationCall(item);
        const previousChars = nativeImageCharsByOutputIndex.get(outputIndex) ?? 0;
        const nextChars = typeof reconciled.result === "string" ? reconciled.result.length : 0;
        const nextTotal = nativeImageBase64Chars - previousChars + nextChars;
        if (nextTotal > MAX_NATIVE_IMAGE_BASE64_CHARS) {
            scrubNativeImageResults();
            throw new Error("Native image generation results exceed the 24 MiB base64 limit");
        }
        nativeImageBase64Chars = nextTotal;
        if (nextChars > 0)
            nativeImageCharsByOutputIndex.set(outputIndex, nextChars);
        else
            nativeImageCharsByOutputIndex.delete(outputIndex);
        slot.block.subtype = "image_generation_call";
        slot.block.raw = reconciled;
    }
    const backfillNativeImageGenerationCalls = (responseOutput) => {
        for (const [outputIndex, outputItem] of responseOutput.entries()) {
            if (finalizedNativeImageOutputIndexes.has(outputIndex))
                continue;
            const imageItem = readNativeImageGenerationCall(outputItem);
            if (!imageItem)
                continue;
            const existingSlot = getSlot(outputIndex, "providerNative");
            if (existingSlot)
                reconcileNativeImageSlot(outputIndex, existingSlot, imageItem);
            else
                createSlot(outputIndex, outputItem);
            outputSlots.delete(outputIndex);
        }
    };`,
		"provider-native-slot",
	);
	next = replaceOnce(
		next,
		`        backfillReasoningSignatures(response.output ?? []);
        if (response?.id) {`,
		`        backfillReasoningSignatures(response.output ?? []);
        backfillNativeImageGenerationCalls(response.output ?? []);
        if (response?.id) {`,
		"native-image-backfill",
	);
	next = replaceOnce(
		next,
		`            const slot = getOrCreateSlot(event.output_index, item);
            if (item.type === "reasoning" && slot?.type === "thinking") {`,
		`            const slot = getOrCreateSlot(event.output_index, item);
            const imageItem = readNativeImageGenerationCall(item);
            if (imageItem && slot?.type === "providerNative") {
                reconcileNativeImageSlot(event.output_index, slot, imageItem);
                finalizedNativeImageOutputIndexes.add(event.output_index);
                outputSlots.delete(event.output_index);
            }
            else if (item.type === "reasoning" && slot?.type === "thinking") {`,
		"native-image-done",
	);
	next = replaceOnce(
		next,
		`                outputSlots.delete(event.output_index);
            }
        }
        else if (event.type === "response.completed" || event.type === "response.incomplete") {`,
		`                outputSlots.delete(event.output_index);
            }
            else if (slot?.type === "providerNative") {
                slot.block.subtype = item.type;
                slot.block.raw = item;
                outputSlots.delete(event.output_index);
            }
        }
        else if (event.type === "response.completed" || event.type === "response.incomplete") {`,
		"provider-native-done",
	);
	return next;
}

export function patchPiAiTypes(source) {
	let next = replaceOnce(
		source,
		`export interface Usage {`,
		`/** Provider-owned Responses content retained for extension handling. */
export interface ProviderNativeContent {
    type: "providerNative";
    subtype: string;
    raw: unknown;
}
export interface Usage {`,
		"provider-native-type",
	);
	next = replaceOnce(
		next,
		`    content: (TextContent | ThinkingContent | ToolCall)[];`,
		`    content: (TextContent | ThinkingContent | ToolCall | ProviderNativeContent)[];`,
		"assistant-content-union",
	);
	return next;
}

export function patchAnthropicMessagesNative(source) {
	let next = replaceOnce(
		source,
		`                    else if (event.content_block.type === "tool_use") {
                        const block = {
                            type: "toolCall",
                            id: event.content_block.id,
                            name: isOAuth
                                ? fromClaudeCodeName(event.content_block.name, context.tools)
                                : event.content_block.name,
                            arguments: event.content_block.input ?? {},
                            partialJson: "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
                    }
                }`,
		`                    else if (event.content_block.type === "tool_use") {
                        const block = {
                            type: "toolCall",
                            id: event.content_block.id,
                            name: isOAuth
                                ? fromClaudeCodeName(event.content_block.name, context.tools)
                                : event.content_block.name,
                            arguments: event.content_block.input ?? {},
                            partialJson: "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
                    }
                    else {
                        const block = {
                            type: "providerNative",
                            subtype: event.content_block.type,
                            raw: event.content_block,
                            index: event.index,
                        };
                        output.content.push(block);
                    }
                }`,
		"native-block-start",
	);
	next = replaceOnce(
		next,
		`                    else if (event.delta.type === "input_json_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "toolCall") {
                            block.partialJson += event.delta.partial_json;
                            block.arguments = parseStreamingJson(block.partialJson);
                            stream.push({
                                type: "toolcall_delta",
                                contentIndex: index,
                                delta: event.delta.partial_json,
                                partial: output,
                            });
                        }
                    }`,
		`                    else if (event.delta.type === "input_json_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "toolCall") {
                            block.partialJson += event.delta.partial_json;
                            block.arguments = parseStreamingJson(block.partialJson);
                            stream.push({
                                type: "toolcall_delta",
                                contentIndex: index,
                                delta: event.delta.partial_json,
                                partial: output,
                            });
                        }
                        else if (block && block.type === "providerNative" && typeof block.raw === "object" && block.raw !== null && (block.raw.type === "server_tool_use" || block.raw.type === "mcp_tool_use")) {
                            block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
                        }
                    }`,
		"native-block-delta",
	);
	next = replaceOnce(
		next,
		`                        else if (block.type === "toolCall") {
                            block.arguments = parseStreamingJson(block.partialJson);
                            // Finalize in-place and strip the scratch buffer so replay only
                            // carries parsed arguments.
                            delete block.partialJson;
                            stream.push({
                                type: "toolcall_end",
                                contentIndex: index,
                                toolCall: block,
                                partial: output,
                            });
                        }
                    }`,
		`                        else if (block.type === "toolCall") {
                            block.arguments = parseStreamingJson(block.partialJson);
                            // Finalize in-place and strip the scratch buffer so replay only
                            // carries parsed arguments.
                            delete block.partialJson;
                            stream.push({
                                type: "toolcall_end",
                                contentIndex: index,
                                toolCall: block,
                                partial: output,
                            });
                        }
                        else if (block.type === "providerNative") {
                            const partialJson = block.partialJson;
                            delete block.partialJson;
                            if (partialJson !== undefined && typeof block.raw === "object" && block.raw !== null) {
                                block.raw = { ...block.raw, input: parseStreamingJson(partialJson) };
                            }
                        }
                    }`,
		"native-block-stop",
	);
	next = replaceOnce(
		next,
		`    const converted = convertMessages(transformedMessages, isOAuthToken, cacheControl, compat.allowEmptySignature, deferredToolNames, normalizeToolName, model.compat?.supportsMidConvoEffort === true ? model.provider : undefined);`,
		`    const converted = convertMessages(transformedMessages, isOAuthToken, cacheControl, compat.allowEmptySignature, deferredToolNames, normalizeToolName, model.compat?.supportsMidConvoEffort === true ? model.provider : undefined, model);`,
		"convert-messages-model",
	);
	next = replaceOnce(
		next,
		`function convertMessages(transformedMessages, isOAuthToken, cacheControl, allowEmptySignature = false, deferredToolNames = new Set(), normalizeToolName = (name) => name, managedProvider) {`,
		`const REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES = new Set([
    "server_tool_use",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "tool_search_tool_result",
    "container_upload",
]);
function pairedAnthropicNativeIds(content) {
    const uses = new Set();
    const results = new Set();
    for (const block of content) {
        if (block.type !== "providerNative" || typeof block.raw !== "object" || block.raw === null)
            continue;
        const raw = block.raw;
        if (raw.type === "server_tool_use" && typeof raw.id === "string")
            uses.add(raw.id);
        if (typeof raw.tool_use_id === "string")
            results.add(raw.tool_use_id);
    }
    const paired = new Set();
    for (const id of uses) {
        if (results.has(id))
            paired.add(id);
    }
    return paired;
}
function convertMessages(transformedMessages, isOAuthToken, cacheControl, allowEmptySignature = false, deferredToolNames = new Set(), normalizeToolName = (name) => name, managedProvider, model) {`,
		"convert-messages-helpers",
	);
	next = replaceOnce(
		next,
		`        else if (msg.role === "assistant") {
            const blocks = [];
            for (const block of msg.content) {`,
		`        else if (msg.role === "assistant") {
            const blocks = [];
            const pairedNativeIds = pairedAnthropicNativeIds(msg.content);
            for (const block of msg.content) {`,
		"convert-messages-paired",
	);
	next = replaceOnce(
		next,
		`                else if (block.type === "toolCall") {
                    blocks.push({
                        type: "tool_use",
                        id: block.id,
                        name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
                        input: block.arguments ?? {},
                    });
                }
            }
            if (blocks.length === 0)
                continue;`,
		`                else if (block.type === "toolCall") {
                    blocks.push({
                        type: "tool_use",
                        id: block.id,
                        name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
                        input: block.arguments ?? {},
                    });
                }
                else if (block.type === "providerNative") {
                    const raw = block.raw;
                    if (model &&
                        msg.provider === model.provider &&
                        msg.api === model.api &&
                        msg.model === model.id &&
                        typeof raw === "object" && raw !== null &&
                        typeof raw.type === "string" &&
                        REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES.has(raw.type)) {
                        const useId = raw.type === "server_tool_use" ? raw.id : raw.tool_use_id;
                        if (typeof useId !== "string" || pairedNativeIds.has(useId))
                            blocks.push(raw);
                    }
                }
            }
            if (blocks.length === 0)
                continue;`,
		"convert-messages-replay",
	);
	return next;
}

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

const runtimeSources = [
	join(featureDir, "LICENSE"),
	join(featureDir, "THIRD_PARTY_NOTICES.md"),
	...walk(join(featureDir, "src")),
].sort();

export const patches = Object.freeze([
	Object.freeze({
		id: "openai-responses-provider-native",
		packageName: "@earendil-works/pi-ai",
		version: VERSION,
		path: "dist/api/openai-responses-shared.js",
		preimageSha256: "b5d9f001e97bfafa8dfeef2e292f923c39f77fa8aef014132bf3530760f222e3",
		apply: patchOpenAiResponsesShared,
	}),
	Object.freeze({
		id: "provider-native-types",
		packageName: "@earendil-works/pi-ai",
		version: VERSION,
		path: "dist/types.d.ts",
		preimageSha256: "8c11014ea6c454bf60c7c22b65cdb00bebd834e4e9ebb07d3f0fffb6a58ea78a",
		apply: patchPiAiTypes,
	}),
	Object.freeze({
		id: "anthropic-messages-provider-native",
		packageName: "@earendil-works/pi-ai",
		version: VERSION,
		path: "dist/api/anthropic-messages.js",
		preimageSha256: "f748560c80fe91bb5736b62f6f34c5e2e2bfa224cd5eb959134ca903c226b604",
		apply: patchAnthropicMessagesNative,
	}),
]);
export const files = Object.freeze(
	runtimeSources.map((sourcePath) =>
		Object.freeze({
			target: "runtime",
			version: VERSION,
			path: `rubato-features/media-tools/${relative(featureDir, sourcePath).split(sep).join("/")}`,
			sourcePath,
		}),
	),
);

export const feature = Object.freeze({ id: "media-tools", patches, files });
