import { replaceOnce } from "./core-replace.mjs";

const PAT_NEEDLE = "    /token limit exceeded/i, // Generic fallback\n    /^4(?:00|13)\\s*(?:status code)?\\s*\\(no body\\)/i, // Cerebras: 400/413 with no body";

const PAT_REPLACEMENT = "    /token limit exceeded/i, // Generic fallback\n    /conversation is too long/i, // ChatGPT / Codex backend\n    /please try a shorter message/i, // ChatGPT / Codex backend\n    /requested context length is too (?:large|long)/i, // ChatGPT / Codex backend\n    /^4(?:00|13)\\s*(?:status code)?\\s*\\(no body\\)/i, // Cerebras: 400/413 with no body";

const HEUR_NEEDLE = "        if (!isNonOverflow &&\n            hasTokenEvidence &&\n            RESOURCE_EXHAUSTED_PATTERN.test(message.errorMessage) &&\n            (contextWindow === undefined || contextWindow <= 0 || cursorZeroTokenCount(message) >= contextWindow * 0.5)) {\n            return true;\n        }\n    }\n";

const HEUR_REPLACEMENT = "        if (!isNonOverflow && hasTokenEvidence && RESOURCE_EXHAUSTED_PATTERN.test(message.errorMessage)) {\n            return true;\n        }\n        // Codex/ChatGPT often wrap window overflow in a policy error whose text\n        // does not match the OpenAI public API wording. If billed input already\n        // fills the window, treat it as overflow so compaction owns the recovery\n        // instead of retrying the same oversized turn.\n        if (!isNonOverflow && contextWindow) {\n            const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0);\n            const total = usage.totalTokens || inputTokens + (usage.output ?? 0);\n            if (Math.max(inputTokens, total) >= contextWindow * 0.99) {\n                return true;\n            }\n        }\n    }\n";

const SILENT_NEEDLE =
  "    // Case 2: Silent overflow (z.ai style) - successful but usage exceeds context\n" +
  "    if (contextWindow && message.stopReason === \"stop\") {\n" +
  "        const inputTokens = message.usage.input + message.usage.cacheRead;\n" +
  "        if (inputTokens > contextWindow) {\n" +
  "            return true;\n" +
  "        }\n" +
  "    }\n";

const SILENT_REPLACEMENT =
  "    // Case 2: Silent overflow (z.ai style) — successful but uncached input exceeds context.\n" +
  "    // Cursor bills cacheRead far above the live prompt; a successful turn already fitted\n" +
  "    // the window, so cacheRead-only overrun is billing noise, not overflow.\n" +
  "    if (contextWindow && message.stopReason === \"stop\") {\n" +
  "        const inputTokens = message.usage.input ?? 0;\n" +
  "        if (inputTokens > contextWindow) {\n" +
  "            return true;\n" +
  "        }\n" +
  "    }\n";

export function isOverflowUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/utils/overflow.js");
}

/** pi-ai series 20260830-0449Z-codex-overflow-detection + Cursor cacheRead silent-overflow. */
export function injectOverflow(source) {
  let next = replaceOnce(source, PAT_NEEDLE, PAT_REPLACEMENT, "overflow codex patterns");
  next = replaceOnce(next, HEUR_NEEDLE, HEUR_REPLACEMENT, "overflow 99% window heuristic");
  return replaceOnce(next, SILENT_NEEDLE, SILENT_REPLACEMENT, "overflow silent stop ignores cacheRead");
}
