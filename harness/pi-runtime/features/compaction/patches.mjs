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
  return replaceOnce(
    next,
    "export function shouldCompact(contextTokens, contextWindow, settings) {\n    if (!settings.enabled)\n        return false;\n    return contextTokens > contextWindow - settings.reserveTokens;\n}",
    "export function shouldCompact(contextTokens, contextWindow, settings) {\n    if (!settings.enabled)\n        return false;\n    if (!(contextWindow > 0)) return false;\n    const ratio = resolveClientCompactionThresholdRatio({ model: settings.model, settings });\n    return contextTokens >= Math.floor(contextWindow * ratio);\n}",
    "should-compact-ratio",
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
  return replaceOnce(
    next,
    "    if (allowedFallbackModels && allowedFallbackModels.length > 0) {\n        params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));\n    }\n    return params;\n}",
    "    if (allowedFallbackModels && allowedFallbackModels.length > 0) {\n        params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));\n    }\n    return applyAnthropicServerCompactionParams(params, model);\n}",
    "anthropic-params",
  );
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
