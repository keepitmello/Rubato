import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";
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
	next = replaceOnce(
		next,
		`                    if (customInputProperty !== undefined) {
                        output.push({
                            type: "custom_tool_call",
                            id: itemId,
                            call_id: callId,`,
		`                    if (customInputProperty !== undefined) {
                        // Codex custom_tool_call item ids must be ctc_*. The Responses
                        // normalizer prefixes fc_* for function_call pairing; sending that
                        // id here 400s with invalid_id_prefix.
                        if (itemId && !itemId.startsWith("ctc_"))
                            itemId = undefined;
                        output.push({
                            type: "custom_tool_call",
                            id: itemId,
                            call_id: callId,`,
		"custom-tool-call-ctc-id",
	);
	next = replaceOnce(
		next,
		"    const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId);",
		"    const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId, options);",
		"transform-messages-options",
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
                                ? fromClaudeCodeName(event.content_block.name, currentTools)
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
                                ? fromClaudeCodeName(event.content_block.name, currentTools)
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
		// 1.0.1 passes a tool-definition converter (inline tool_addition definitions) as the
		// sixth argument instead of a nativeToolChanges flag; the model still goes last.
		`        ? (tools) => convertTools(tools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools)
        : undefined);`,
		`        ? (tools) => convertTools(tools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools)
        : undefined, model);`,
		"convert-messages-model",
	);
	next = replaceOnce(
		next,
		`function convertMessages(transformedMessages, isOAuthToken, cacheControl, allowEmptySignature = false, managedProvider, \n/** Converts tool definitions for native \`tool_addition\` blocks; undefined when tool changes are not native. */\nconvertToolDefinitions) {`,
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
function isAnthropicWebSearchReplayBlock(raw) {
    if (!raw || typeof raw !== "object")
        return false;
    if (raw.type === "web_search_tool_result")
        return true;
    return raw.type === "server_tool_use" && raw.name === "web_search";
}
function convertMessages(transformedMessages, isOAuthToken, cacheControl, allowEmptySignature = false, managedProvider, \n/** Converts tool definitions for native \`tool_addition\` blocks; undefined when tool changes are not native. */\nconvertToolDefinitions, model) {`,
		"convert-messages-helpers",
	);
	next = replaceOnce(
		next,
		`        else if (msg.role === "assistant") {
            flushPendingSystemMessages();
            const blocks = [];
            for (const block of msg.content) {`,
		`        else if (msg.role === "assistant") {
            flushPendingSystemMessages();
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
                        REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES.has(raw.type) &&
                        !( !model.compat?.supportsWebSearch && isAnthropicWebSearchReplayBlock(raw) )) {
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

const READ_MEDIA_IMPORT = 'import { readMediaFile } from "../../../../../../rubato-features/media-tools/src/read-media/index.mjs";\n';

/** `read` hands video and audio to read-media before its image and text paths. */
export function patchReadMedia(source) {
	let next = replaceOnce(
		source,
		'import { processImage } from "../../utils/image-process.js";\n',
		`${READ_MEDIA_IMPORT}import { processImage } from "../../utils/image-process.js";\n`,
		"read-media-import",
	);
	next = replaceOnce(
		next,
		'    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),\n    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),',
		'    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed); for video and audio, the start in seconds" })),\n    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read; for video and audio, the length in seconds" })),',
		"read-media-schema",
	);
	next = replaceOnce(
		next,
		"Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments.",
		"Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. Video and audio files (mp4, mov, webm, mkv, mp3, wav, m4a, ...) are sent to Gemini models as media, re-encoded to 1 fps with mono audio; Gemini watches the frames and hears the audio.",
		"read-media-description",
	);
	return replaceOnce(
		next,
		"                        const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;\n",
		`                        const media = ops === defaultReadOperations
                            ? await readMediaFile(absolutePath, ctx?.model, { offset, limit, signal })
                            : undefined;
                        if (aborted)
                            return;
                        if (media) {
                            signal?.removeEventListener("abort", onAbort);
                            resolve({ content: media.content, details: undefined });
                            return;
                        }
                        const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;\n`,
		"read-media-dispatch",
	);
}

/** Video and audio ride in image blocks; the terminal draws only real images. */
export function patchToolExecutionMedia(source) {
	return replaceOnce(
		source,
		'            const imageBlocks = this.result.content.filter((c) => c.type === "image");',
		'            const imageBlocks = this.result.content.filter((c) => c.type === "image" && !/^(video|audio)\\//i.test(String(c.mimeType)));',
		"tool-execution-media",
	);
}

/**
 * Gemini function responses take images, PDF and text only (Vertex function calling docs,
 * 2026-10-10). Video next to a functionResponse in the same turn makes Vertex answer 400
 * "Requests ending with a model turn are not supported" (measured 2026-10-15, Gemini 4 Argon),
 * so video and audio wait until the run of function responses ends and follow as their own user
 * turn. Video asks for high media resolution: 280 tokens a frame instead of 70, which Google
 * names as the setting for reading on-screen text.
 */
export function patchGoogleSharedMedia(source) {
	let next = replaceOnce(
		source,
		`    const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);
    for (const msg of transformedMessages) {
`,
		`    const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);
    let pendingMediaParts = [];
    const flushMediaParts = () => {
        if (pendingMediaParts.length === 0)
            return;
        contents.push({ role: "user", parts: [{ text: "Tool result media:" }, ...pendingMediaParts] });
        pendingMediaParts = [];
    };
    for (const msg of transformedMessages) {
        if (msg.role !== "toolResult")
            flushMediaParts();
`,
		"google-media-pending",
	);
	next = replaceOnce(
		next,
		`            const imageParts = imageContent.map((imageBlock) => ({
                inlineData: {
                    mimeType: imageBlock.mimeType,
                    data: imageBlock.data,
                },
            }));`,
		`            const isTimedMedia = (block) => /^(video|audio)\\//i.test(String(block.mimeType));
            const imageParts = imageContent.filter((block) => !isTimedMedia(block)).map((imageBlock) => ({
                inlineData: {
                    mimeType: imageBlock.mimeType,
                    data: imageBlock.data,
                },
            }));
            const mediaParts = imageContent.filter(isTimedMedia).map((block) => ({
                inlineData: {
                    mimeType: block.mimeType,
                    data: block.data,
                },
                ...(/^video\\//i.test(block.mimeType) ? { mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" } } : {}),
            }));`,
		"google-media-parts",
	);
	next = replaceOnce(
		next,
		"                    ...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),",
		"                    ...(imageParts.length > 0 && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),",
		"google-media-nested-images",
	);
	next = replaceOnce(
		next,
		`            // For Gemini < 3, add images in a separate user message
            if (hasImages && !modelSupportsMultimodalFunctionResponse) {`,
		`            pendingMediaParts.push(...mediaParts);
            // For Gemini < 3, add images in a separate user message
            if (imageParts.length > 0 && !modelSupportsMultimodalFunctionResponse) {`,
		"google-media-queue",
	);
	return replaceOnce(
		next,
		"    return contents;\n}",
		"    flushMediaParts();\n    return contents;\n}",
		"google-media-flush",
	);
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

// src/model-core holds source-tree shims; the stage gets the real modules from packages/model-core.
const modelCoreDir = fileURLToPath(new URL("../../../../packages/model-core/src/", import.meta.url));
function stagedSourceOf(sourcePath) {
	const fromSrc = relative(join(featureDir, "src", "model-core"), sourcePath);
	return fromSrc.startsWith("..") ? sourcePath : join(modelCoreDir, fromSrc);
}

export const patches = Object.freeze([
	Object.freeze({
		id: "openai-responses-provider-native",
		packageName: "@earendil-works/pi-ai",
		version: VERSION,
		path: "dist/api/openai-responses-shared.js",
		preimageSha256: "8744ad2ce9ce2512993360600760f5bcdbeb520d0a641c655b2a0b7cbe9db10a",
		apply: patchOpenAiResponsesShared,
	}),
	Object.freeze({
		id: "provider-native-types",
		packageName: "@earendil-works/pi-ai",
		version: VERSION,
		path: "dist/types.d.ts",
		preimageSha256: "c1cad96358be23269443a25171c76d6456c00dcc2ec7ef7b1dad812bcb2ea0f0",
		apply: patchPiAiTypes,
	}),
	Object.freeze({
		id: "anthropic-messages-provider-native",
		packageName: "@earendil-works/pi-ai",
		version: VERSION,
		path: "dist/api/anthropic-messages.js",
		preimageSha256: "beb7ec1ad646151f73ee0199c2b30b944d4066e9ba0fa47421aa446ab3d7ec96",
		apply: patchAnthropicMessagesNative,
	}),
	Object.freeze({
		id: "google-shared-media",
		packageName: "@earendil-works/pi-ai",
		version: VERSION,
		path: "dist/api/google-shared.js",
		preimageSha256: "0254007d8b7f0ebeb2b00f6a940041012c45220369f604f999c8e7019d36972a",
		apply: patchGoogleSharedMedia,
	}),
	Object.freeze({
		id: "read-media",
		packageName: "@earendil-works/pi-coding-agent",
		version: VERSION,
		path: "dist/core/tools/read.js",
		preimageSha256: "6be7949968968f42a17ccbe341008db3f061cc1d757b42ff1d269bb0d4cc66f1",
		apply: patchReadMedia,
	}),
	Object.freeze({
		id: "tool-execution-media",
		packageName: "@earendil-works/pi-coding-agent",
		version: VERSION,
		path: "dist/modes/interactive/components/tool-execution.js",
		preimageSha256: "84c0b25031d0702f7599f6a779642c3bf7822e1f89919a543901da733e817941",
		apply: patchToolExecutionMedia,
	}),
]);
export const files = Object.freeze(
	runtimeSources.map((sourcePath) =>
		Object.freeze({
			target: "runtime",
			version: VERSION,
			path: `rubato-features/media-tools/${relative(featureDir, sourcePath).split(sep).join("/")}`,
			sourcePath: stagedSourceOf(sourcePath),
		}),
	),
);

export const feature = Object.freeze({ id: "media-tools", patches, files });
