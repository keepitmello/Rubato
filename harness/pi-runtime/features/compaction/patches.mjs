import {
  ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER,
  ANTHROPIC_SERVER_COMPACTION_MODEL_IDS,
  serverCompactionMarkerStatement,
} from "./anthropic-server-compaction.mjs";

const PACKAGE_AGENT = "@earendil-works/pi-coding-agent";
const PACKAGE_AI = "@earendil-works/pi-ai";
const PACKAGE_VERSION = "0.85.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[compaction:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[compaction:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) {
    throw new Error(`[compaction:${label}] expected pristine feature seam`);
  }
}

function replaceConstTemplate(source, constName, nextBody, label) {
  const startNeedle = "const " + constName + " = `";
  const start = source.indexOf(startNeedle);
  if (start === -1) throw new Error("[compaction:" + label + "] expected " + constName + " template");
  const end = source.indexOf("`;", start + startNeedle.length);
  if (end === -1) throw new Error("[compaction:" + label + "] expected " + constName + " terminator");
  if (source.indexOf(startNeedle, start + startNeedle.length) !== -1) {
    throw new Error("[compaction:" + label + "] " + constName + " template is ambiguous");
  }
  return source.slice(0, start) + startNeedle + nextBody + "`;" + source.slice(end + 2);
}

const GUIDANCE_IMPORT = 'import { COMPACTION_BRIEFING_GUIDANCE } from "../../rubato-features/compaction/guidance.mjs";';
const THRESHOLD_IMPORT = 'import { resolveClientCompactionThresholdRatio } from "../../rubato-features/compaction/threshold.mjs";';
const PARAMS_IMPORT = 'import { applyAnthropicServerCompactionParams } from "../rubato-features/compaction/anthropic-server-compaction-wire.mjs";';

export function patchCompactionPromptsAndThreshold(source) {
  unpatched(source, GUIDANCE_IMPORT, "compaction-js");
  let next = replaceOnce(
    source,
    'import { computeFileLists, createFileOps, extractFileOpsFromMessage, formatFileOperations, SUMMARIZATION_SYSTEM_PROMPT, serializeConversation, } from "./utils.js";',
    'import { computeFileLists, createFileOps, extractFileOpsFromMessage, formatFileOperations, SUMMARIZATION_SYSTEM_PROMPT, serializeConversation, } from "./utils.js";\n' + GUIDANCE_IMPORT + "\n" + THRESHOLD_IMPORT,
    "compaction-imports",
  );
  next = replaceConstTemplate(
    next,
    "SUMMARIZATION_PROMPT",
    "The messages above are a conversation to summarize.\n\n${COMPACTION_BRIEFING_GUIDANCE}",
    "summarization-prompt",
  );
  next = replaceConstTemplate(
    next,
    "UPDATE_SUMMARIZATION_INSTRUCTIONS",
    "Write a single updated briefing that merges the previous briefing with the new messages. Nothing from the previous briefing that the guidance below asks to preserve may be dropped.\n\n${COMPACTION_BRIEFING_GUIDANCE}",
    "update-instructions",
  );
  next = replaceOnce(
    next,
    "export function shouldCompact(contextTokens, contextWindow, settings) {\n    if (!settings.enabled)\n        return false;\n    return contextTokens > contextWindow - settings.reserveTokens;\n}",
    "export function shouldCompact(contextTokens, contextWindow, settings) {\n    if (!settings.enabled)\n        return false;\n    if (!(contextWindow > 0)) return false;\n    const ratio = resolveClientCompactionThresholdRatio({ model: settings.model, settings });\n    return contextTokens >= Math.floor(contextWindow * ratio);\n}",
    "should-compact-ratio",
  );
  next = replaceOnce(
    next,
    "    const llmMessages = convertToLlm(currentMessages);",
    "    const llmMessages = convertToLlm(model?.provider === \"cursor\"\n        ? currentMessages.map((msg) => msg.role === \"assistant\" && Array.isArray(msg.content)\n            ? { ...msg, content: msg.content.filter((block) => block.type !== \"thinking\") }\n            : msg)\n        : currentMessages);",
    "strip-cursor-thinking",
  );
  next = replaceOnce(
    next,
    "    if (response.content.some((block) => block.type === \"toolCall\")) {\n        throw new Error(\"Summarization attempted to call a tool\");\n    }",
    "    if (response.content.some((block) => block.type === \"toolCall\")) {\n        const retried = await completeSummarization(model, buildSummarizationContext(promptText), completionOptions, streamFn, retry, callbacks);\n        if (retried.content.some((block) => block.type === \"toolCall\")) {\n            const budget = Math.min(20000, Math.max(2000, Math.floor(maxTokens * 3)));\n            const marker = \"[Automatic compaction summary unavailable: the summarization request returned a tool call instead of text, twice in a row. Preserving bounded raw context below instead of losing this segment.]\";\n            const body = conversationText.length <= budget ? conversationText : `${conversationText.slice(0, Math.floor((budget - 24) / 2))}\\n\\n[... elided ...]\\n\\n${conversationText.slice(conversationText.length - Math.floor((budget - 24) / 2))}`;\n            return { text: `${marker}\\n\\n<conversation-excerpt>\\n${body}\\n</conversation-excerpt>`, usage: retried.usage };\n        }\n        const textContent = contentText(retried.content);\n        return { text: textContent, usage: retried.usage };\n    }",
    "summary-toolcall-fallback",
  );
  return replaceOnce(
    next,
    "    if (response.content.some((block) => block.type === \"toolCall\")) {\n        throw new Error(\"Turn prefix summarization attempted to call a tool\");\n    }",
    "    if (response.content.some((block) => block.type === \"toolCall\")) {\n        const retried = await completeSummarization(model, buildSummarizationContext(promptText), createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId), streamFn, retry, callbacks);\n        if (retried.content.some((block) => block.type === \"toolCall\")) {\n            const budget = Math.min(20000, Math.max(2000, Math.floor(maxTokens * 3)));\n            const marker = \"[Automatic turn-prefix summary unavailable: the summarization request returned a tool call instead of text, twice in a row. The retained suffix below is authoritative; preserving a bounded raw excerpt of the discarded prefix instead of losing it.]\";\n            const body = conversationText.length <= budget ? conversationText : `${conversationText.slice(0, Math.floor((budget - 24) / 2))}\\n\\n[... elided ...]\\n\\n${conversationText.slice(conversationText.length - Math.floor((budget - 24) / 2))}`;\n            return { text: `${marker}\\n\\n<turn-prefix-excerpt>\\n${body}\\n</turn-prefix-excerpt>`, usage: retried.usage };\n        }\n        return { text: contentText(retried.content), usage: retried.usage };\n    }",
    "turn-prefix-toolcall-fallback",
  );
}

export function patchSettingsCompactionKeys(source) {
  return replaceOnce(
    source,
    "    getCompactionSettings() {\n        return {\n            enabled: this.getCompactionEnabled(),\n            reserveTokens: this.getCompactionReserveTokens(),\n            keepRecentTokens: this.getCompactionKeepRecentTokens(),\n        };\n    }",
    "    getCompactionSettings() {\n        return {\n            enabled: this.getCompactionEnabled(),\n            reserveTokens: this.getCompactionReserveTokens(),\n            keepRecentTokens: this.getCompactionKeepRecentTokens(),\n            thresholdRatio: this.settings.compaction?.thresholdRatio,\n            models: this.settings.compaction?.models ?? this.settings.compaction?.thresholdByModel,\n        };\n    }",
    "settings-threshold-keys",
  );
}

export function patchAnthropicMessagesServerCompaction(source) {
  unpatched(source, PARAMS_IMPORT, "anthropic-messages");
  let next = replaceOnce(
    source,
    'import Anthropic from "@anthropic-ai/sdk";',
    'import Anthropic from "@anthropic-ai/sdk";\n' + PARAMS_IMPORT,
    "anthropic-import",
  );
  next = replaceOnce(
    next,
    'const claudeCodeVersion = "2.1.251";',
    'const claudeCodeVersion = "2.1.269";',
    "claude-code-version",
  );
  next = replaceOnce(
    next,
    'text: "You are Claude Code, Anthropic\'s official CLI for Claude.",',
    'text: "x-anthropic-billing-header: cc_version=2.1.269; cc_entrypoint=cli;",\n            },\n            {\n                type: "text",\n                text: "You are Claude Code, Anthropic\'s official CLI for Claude.",',
    "claude-code-billing-header",
  );
  next = replaceOnce(
    next,
    "    if (allowedFallbackModels && allowedFallbackModels.length > 0) {\n        params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));\n    }\n    return params;\n}",
    "    if (allowedFallbackModels && allowedFallbackModels.length > 0) {\n        params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));\n    }\n    return applyAnthropicServerCompactionParams(params, model);\n}",
    "anthropic-params",
  );
  const nativeElse = `                    else {
                        const block = {
                            type: "providerNative",
                            subtype: event.content_block.type,
                            raw: event.content_block,
                            index: event.index,
                        };
                        output.content.push(block);
                    }`;
  if (!next.includes("    return paired;\n}\nfunction convertMessages(") || !next.includes(nativeElse)) {
    return next;
  }
  const modelIdsLiteral = JSON.stringify([...ANTHROPIC_SERVER_COMPACTION_MODEL_IDS]);
  next = replaceOnce(
    next,
    "    return paired;\n}\nfunction convertMessages(",
    `    return paired;
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
const ANTHROPIC_SERVER_COMPACTION_MODEL_IDS = new Set(${modelIdsLiteral});
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
            if (block?.type !== "providerNative" || block.subtype !== "compaction")
                continue;
            const raw = block.raw;
            if (!raw || typeof raw !== "object" || raw.type !== "compaction")
                continue;
            if (typeof raw.content !== "string" || raw.content.length === 0)
                continue;
            return { messageIndex, blockIndex };
        }
    }
    return undefined;
}
function shouldOmitThinkingBeforeCompaction(cut, messageIndex, blockIndex) {
    return !!cut && (messageIndex < cut.messageIndex || (messageIndex === cut.messageIndex && blockIndex < cut.blockIndex));
}
function convertMessages(`,
    "anthropic-compaction-helpers",
  );
  next = replaceOnce(
    next,
    `                    else {
                        const block = {
                            type: "providerNative",
                            subtype: event.content_block.type,
                            raw: event.content_block,
                            index: event.index,
                        };
                        output.content.push(block);
                    }`,
    `                    else if (event.content_block.type === "compaction") {
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
                    }`,
    "anthropic-compaction-start",
  );
  next = replaceOnce(
    next,
    `                    else if (event.delta.type === "signature_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "thinking") {
                            block.thinkingSignature = block.thinkingSignature || "";
                            block.thinkingSignature += event.delta.signature;
                        }
                    }`,
    `                    else if (event.delta.type === "signature_delta") {
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
                        if (block && block.type === "providerNative" && block.subtype === "compaction" && block.raw && typeof block.raw === "object") {
                            block.raw.content = event.delta.content ?? event.delta.summary ?? block.raw.content;
                        }
                    }`,
    "anthropic-compaction-delta",
  );
  next = replaceOnce(
    next,
    `                    output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(usageModel, output.usage);`,
    `                    output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    applyAnthropicCompactionUsage(output.usage, event.message.usage);
                    calculateCost(usageModel, output.usage);
                    addAnthropicCompactionCost(usageModel, output.usage);`,
    "anthropic-compaction-start-usage",
  );
  next = replaceOnce(
    next,
    `                        if (thinkingTokens != null) {
                            output.usage.reasoning = thinkingTokens;
                        }
                    }
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(usageModel, output.usage);`,
    `                        if (thinkingTokens != null) {
                            output.usage.reasoning = thinkingTokens;
                        }
                    }
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    applyAnthropicCompactionUsage(output.usage, event.usage);
                    calculateCost(usageModel, output.usage);
                    addAnthropicCompactionCost(usageModel, output.usage);`,
    "anthropic-compaction-delta-usage",
  );
  next = replaceOnce(
    next,
    `    const loadedToolNames = new Set();
    for (let i = 0; i < transformedMessages.length; i++) {`,
    `    const loadedToolNames = new Set();
    const compactionCut = lastReplayableAnthropicCompactionCut(transformedMessages, model);
    for (let i = 0; i < transformedMessages.length; i++) {`,
    "anthropic-compaction-cut",
  );
  next = replaceOnce(
    next,
    `            const pairedNativeIds = pairedAnthropicNativeIds(msg.content);
            for (const block of msg.content) {
                if (block.type === "text") {`,
    `            const pairedNativeIds = pairedAnthropicNativeIds(msg.content);
            for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
                const block = msg.content[blockIndex];
                if (block.type === "text") {`,
    "anthropic-compaction-block-index",
  );
  next = replaceOnce(
    next,
    `                else if (block.type === "thinking") {
                    // Redacted thinking: pass the opaque payload back as redacted_thinking`,
    `                else if (block.type === "thinking") {
                    // Fable 5.1: 최신 compaction 이전 thinking/redacted_thinking 은 재전송하면 400.
                    if (shouldOmitThinkingBeforeCompaction(compactionCut, i, blockIndex))
                        continue;
                    // Redacted thinking: pass the opaque payload back as redacted_thinking`,
    "anthropic-compaction-omit-thinking",
  );
  next = replaceOnce(
    next,
    `                else if (block.type === "providerNative") {
                    const raw = block.raw;
                    if (model &&
                        msg.provider === model.provider &&
                        msg.api === model.api &&
                        msg.model === model.id &&
                        typeof raw === "object" && raw !== null &&
                        typeof raw.type === "string" &&
                        REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES.has(raw.type)) {`,
    `                else if (block.type === "providerNative") {
                    const raw = block.raw;
                    if (block.subtype === "compaction" && raw && typeof raw === "object" && raw.type === "compaction") {
                        const content = raw.content;
                        if (typeof content === "string" && content.length > 0 &&
                            model && msg.provider === model.provider && msg.api === model.api &&
                            supportsAnthropicServerCompactionModel(model)) {
                            blocks.push({ type: "compaction", content });
                        }
                    }
                    else if (model &&
                        msg.provider === model.provider &&
                        msg.api === model.api &&
                        msg.model === model.id &&
                        typeof raw === "object" && raw !== null &&
                        typeof raw.type === "string" &&
                        REPLAYABLE_ANTHROPIC_PROVIDER_NATIVE_TYPES.has(raw.type)) {`,
    "anthropic-compaction-replay",
  );
  return next + serverCompactionMarkerStatement(ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER);
}

function patch(packageName, path, preimageSha256, apply, id) {
  return Object.freeze({
    id,
    packageName,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

export const patches = Object.freeze([
  patch(PACKAGE_AGENT, "dist/core/compaction/compaction.js", "3d5f1f2a3e801c965214717b6abad1839239b4a030517bffdf0c8eff25df5c2a", patchCompactionPromptsAndThreshold, "compaction:prompts-threshold"),
  patch(PACKAGE_AGENT, "dist/core/settings-manager.js", "ee4f52d1dd4f1c18d5d814be4ba260ddf7fe40b7b70c2f0732a30a8b287111ad", patchSettingsCompactionKeys, "compaction:settings-threshold-keys"),
  patch(PACKAGE_AI, "dist/api/anthropic-messages.js", "f748560c80fe91bb5736b62f6f34c5e2e2bfa224cd5eb959134ca903c226b604", patchAnthropicMessagesServerCompaction, "compaction:anthropic-server-params"),
]);

export default patches;
