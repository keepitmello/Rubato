import { replaceOnce } from "./core-replace.mjs";

const FN_NEEDLE = "/**\n * Reasoning override for summarization requests. Compaction must be fast: a\n * summarization request that inherits the provider's default reasoning mode\n * burns its latency (and output budget) on invisible thinking before emitting\n * the summary. Disable or minimize reasoning per wire family; adapters ignore\n * options their provider does not support. Mirrors how OpenAI Codex keeps its\n * compaction turn cheap.\n */\nfunction summarizationReasoningOptions(model) {\n    if (!model.reasoning)\n        return {};\n    if (model.api === \"anthropic-messages\")\n        return { thinkingEnabled: false };\n    const reasoningEffort = [\"low\", \"medium\", \"high\"].find((level) => model.thinkingLevelMap?.[level] !== null);\n    if (!reasoningEffort)\n        return {};\n    switch (model.api) {\n        case \"openai-responses\":\n        case \"openai-codex-responses\":\n        case \"azure-openai-responses\":\n            return { reasoningEffort, reasoningSummary: null };\n        case \"openai-completions\":\n            return { reasoningEffort };\n        default:\n            return {};\n    }\n}\n";

export function isSpeculativeUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/speculative.js");
}

/** Baseline: drop speculative cheap-reasoning override. */
export function injectSpeculative(source) {
  let next = replaceOnce(source, FN_NEEDLE, "", "speculative reasoning override fn");
  return replaceOnce(
    next,
    "            signal: requestController.signal,\n            ...summarizationReasoningOptions(options.snapshot.model),\n        });",
    "            signal: requestController.signal,\n        });",
    "speculative reasoning spread",
  );
}
