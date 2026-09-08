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
