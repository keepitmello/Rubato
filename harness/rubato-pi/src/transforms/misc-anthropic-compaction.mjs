import { replaceOnce } from "./misc-replace.mjs";
import {
  ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER,
  ANTHROPIC_SERVER_COMPACTION_MODEL_IDS,
  serverCompactionMarkerStatement,
} from "../anthropic-server-compaction.mjs";

// 재전송 대상 모델 판별에 바로 굽는다 — 목록은 `anthropic-server-compaction.mjs` 하나만 이 진실이다.
const MODEL_IDS_LITERAL = JSON.stringify([...ANTHROPIC_SERVER_COMPACTION_MODEL_IDS]);

// pinned pi-ai 0.84.2 `anthropic-messages.js` 니들. 바이트가 어긋나면 replaceOnce 가 던진다.

const HELPERS_NEEDLE = `function isRecord(value) {
    return typeof value === "object" && value !== null;
}`;

const HELPERS_REPLACEMENT = `function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function applyAnthropicCompactionUsage(usage, rawUsage) {
    const iterations = rawUsage?.iterations;
    if (!Array.isArray(iterations))
        return;
    const compaction = iterations.find((it) => it && it.type === "compaction");
    if (!compaction) {
        delete usage.compaction;
        return;
    }
    usage.compaction = {
        input: compaction.input_tokens || 0,
        output: compaction.output_tokens || 0,
        cacheRead: compaction.cache_read_input_tokens || 0,
        cacheWrite: compaction.cache_creation_input_tokens || 0,
        cacheWrite1h: compaction.cache_creation?.ephemeral_1h_input_tokens || 0,
    };
}
const ANTHROPIC_SERVER_COMPACTION_MODEL_IDS = new Set(${MODEL_IDS_LITERAL});
function supportsAnthropicServerCompactionModel(model) {
    return model?.provider === "anthropic" && ANTHROPIC_SERVER_COMPACTION_MODEL_IDS.has(model.id);
}
function addAnthropicCompactionCost(model, usage) {
    const compaction = usage.compaction;
    if (!compaction)
        return;
    const extra = {
        input: compaction.input,
        output: compaction.output,
        cacheRead: compaction.cacheRead,
        cacheWrite: compaction.cacheWrite,
        cacheWrite1h: compaction.cacheWrite1h || 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(model, extra);
    usage.cost.input += extra.cost.input;
    usage.cost.output += extra.cost.output;
    usage.cost.cacheRead += extra.cost.cacheRead;
    usage.cost.cacheWrite += extra.cost.cacheWrite;
    usage.cost.total += extra.cost.total;
}
function lastReplayableAnthropicCompactionCut(messages, model) {
    if (!Array.isArray(messages) || !supportsAnthropicServerCompactionModel(model))
        return undefined;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
        const msg = messages[messageIndex];
        if (msg.role !== "assistant" || !Array.isArray(msg.content))
            continue;
        if (msg.provider !== model.provider || msg.api !== model.api)
            continue;
        for (let blockIndex = msg.content.length - 1; blockIndex >= 0; blockIndex--) {
            const block = msg.content[blockIndex];
            if (block?.type !== "providerNative" || block.subtype !== "compaction" || !isRecord(block.raw) || block.raw.type !== "compaction")
                continue;
            if (typeof block.raw.content !== "string" || block.raw.content.length === 0)
                continue;
            return { messageIndex, blockIndex };
        }
    }
    return undefined;
}
function shouldOmitThinkingBeforeCompaction(cut, messageIndex, blockIndex) {
    return !!cut && (messageIndex < cut.messageIndex || (messageIndex === cut.messageIndex && blockIndex < cut.blockIndex));
}`;

const REPLAYABLE_NEEDLE = `    "fallback",
]);`;

const REPLAYABLE_REPLACEMENT = `    "fallback",
    "compaction",
]);`;

const START_NEEDLE = `                    else {
                        const block = {
                            type: "providerNative",
                            subtype: event.content_block.type,
                            raw: event.content_block,
                            index: event.index,
                        };
                        output.content.push(block);
                        // Native blocks are represented in output.content but have no dedicated stream event variant.
                    }`;

const START_REPLACEMENT = `                    else if (event.content_block.type === "compaction") {
                        const startContent = event.content_block.content;
                        const block = {
                            type: "providerNative",
                            subtype: "compaction",
                            raw: {
                                type: "compaction",
                                content: typeof startContent === "string" || startContent === null ? startContent : null,
                            },
                            index: event.index,
                        };
                        output.content.push(block);
                    }
                    else {
                        const block = {
                            type: "providerNative",
                            subtype: event.content_block.type,
                            raw: event.content_block,
                            index: event.index,
                        };
                        output.content.push(block);
                        // Native blocks are represented in output.content but have no dedicated stream event variant.
                    }`;

const DELTA_NEEDLE = `                    else if (event.delta.type === "signature_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "thinking") {
                            block.thinkingSignature = block.thinkingSignature || "";
                            block.thinkingSignature += event.delta.signature;
                        }
                    }`;

const DELTA_REPLACEMENT = `                    else if (event.delta.type === "signature_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "thinking") {
                            block.thinkingSignature = block.thinkingSignature || "";
                            block.thinkingSignature += event.delta.signature;
                        }
                    }
                    else if (event.delta.type === "compaction_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "providerNative" && block.subtype === "compaction" && isRecord(block.raw)) {
                            // 문서는 delta 가 content 한 번에 온다. null 은 서버 요약 실패 — 그대로 둔다.
                            block.raw.content = event.delta.content ?? event.delta.summary ?? block.raw.content;
                        }
                    }`;

const START_USAGE_NEEDLE = `                    output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(model, output.usage);`;

const START_USAGE_REPLACEMENT = `                    output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    applyAnthropicCompactionUsage(output.usage, event.message.usage);
                    calculateCost(model, output.usage);
                    addAnthropicCompactionCost(model, output.usage);`;

const DELTA_USAGE_NEEDLE = `                        if (thinkingTokens != null) {
                            output.usage.reasoning = thinkingTokens;
                        }
                    }
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(model, output.usage);`;

const DELTA_USAGE_REPLACEMENT = `                        if (thinkingTokens != null) {
                            output.usage.reasoning = thinkingTokens;
                        }
                    }
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    applyAnthropicCompactionUsage(output.usage, event.usage);
                    calculateCost(model, output.usage);
                    addAnthropicCompactionCost(model, output.usage);`;

const CONVERT_CUT_NEEDLE = `    const providerNativeToolPairing = collectProviderNativeToolPairing(transformedMessages, model, deferredToolNames, normalizeToolName, discardedFallbackToolCallIds);
    for (let i = 0; i < transformedMessages.length; i++) {`;

const CONVERT_CUT_REPLACEMENT = `    const providerNativeToolPairing = collectProviderNativeToolPairing(transformedMessages, model, deferredToolNames, normalizeToolName, discardedFallbackToolCallIds);
    const compactionCut = lastReplayableAnthropicCompactionCut(transformedMessages, model);
    for (let i = 0; i < transformedMessages.length; i++) {`;

const THINKING_NEEDLE = `                else if (block.type === "thinking") {
                    // Redacted thinking: pass the opaque payload back as redacted_thinking`;

const THINKING_REPLACEMENT = `                else if (block.type === "thinking") {
                    // Fable 5.1: 최신 compaction 이전 thinking/redacted_thinking 은 재전송하면 400.
                    if (shouldOmitThinkingBeforeCompaction(compactionCut, i, blockIndex))
                        continue;
                    // Redacted thinking: pass the opaque payload back as redacted_thinking`;

const REPLAY_NEEDLE = `                else if (block.type === "providerNative") {
                    if (isSameModel &&
                        isReplayableAnthropicProviderNativeBlock(block.raw) &&
                        !(rejectsNativeWebSearchReplay && isAnthropicWebSearchReplayBlock(block.raw)) &&
                        !isUnpairedProviderNativeToolBlock(block.raw, providerNativeToolPairing)) {
                        blocks.push(block.raw);
                    }
                }`;

const REPLAY_REPLACEMENT = `                else if (block.type === "providerNative") {
                    const isCompaction = block.subtype === "compaction" && isRecord(block.raw) && block.raw.type === "compaction";
                    const sameAnthropicApi = msg.provider === model.provider && msg.api === model.api && supportsAnthropicServerCompactionModel(model);
                    if (isCompaction) {
                        const content = block.raw.content;
                        if (typeof content === "string" && content.length > 0 && sameAnthropicApi) {
                            blocks.push({ type: "compaction", content });
                        }
                    }
                    else if (isSameModel &&
                        isReplayableAnthropicProviderNativeBlock(block.raw) &&
                        !(rejectsNativeWebSearchReplay && isAnthropicWebSearchReplayBlock(block.raw)) &&
                        !isUnpairedProviderNativeToolBlock(block.raw, providerNativeToolPairing)) {
                        blocks.push(block.raw);
                    }
                }`;

export function isAnthropicCompactionUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/anthropic-messages.js");
}

/**
 * pinned anthropic-messages 에 서버 컴팩션 블록 수신/재전송과 iteration 사용량을 심는다.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectAnthropicCompaction(source) {
  let next = replaceOnce(source, HELPERS_NEEDLE, HELPERS_REPLACEMENT, "anthropic-compaction helpers");
  next = replaceOnce(next, REPLAYABLE_NEEDLE, REPLAYABLE_REPLACEMENT, "anthropic-compaction replayable types");
  next = replaceOnce(next, START_NEEDLE, START_REPLACEMENT, "anthropic-compaction content_block_start");
  next = replaceOnce(next, DELTA_NEEDLE, DELTA_REPLACEMENT, "anthropic-compaction content_block_delta");
  next = replaceOnce(next, START_USAGE_NEEDLE, START_USAGE_REPLACEMENT, "anthropic-compaction message_start usage");
  next = replaceOnce(next, DELTA_USAGE_NEEDLE, DELTA_USAGE_REPLACEMENT, "anthropic-compaction message_delta usage");
  next = replaceOnce(next, CONVERT_CUT_NEEDLE, CONVERT_CUT_REPLACEMENT, "anthropic-compaction convertMessages cut");
  next = replaceOnce(next, THINKING_NEEDLE, THINKING_REPLACEMENT, "anthropic-compaction thinking omit");
  next = replaceOnce(next, REPLAY_NEEDLE, REPLAY_REPLACEMENT, "anthropic-compaction convertMessages replay");
  return next + serverCompactionMarkerStatement(ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER);
}
