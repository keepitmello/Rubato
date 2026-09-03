import { replaceOnce } from "./core-replace.mjs";

export function compactionPolicyHrefs() {
  return {
    threshold: new URL("../client-compaction-threshold.mjs", import.meta.url).href,
  };
}

export function isCompactionPolicyUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/policy.js");
}

export function isSettingsManagerUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/settings-manager.js");
}

export function isCompactionIndexThresholdUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/index.js");
}

const POLICY_HELPER =
  "function configuredOrAdaptiveThreshold(contextWindow, settings, lastYield) {\n" +
  "    const configured = resolveClientCompactionThresholdRatio({ model: settings?.model, settings });\n" +
  "    if (configured !== undefined)\n" +
  "        return configured;\n" +
  "    return computeEffectiveThreshold(contextWindow, lastYield);\n" +
  "}\n";

const SETTINGS_NEEDLE =
  "            idleCompactionEnabled: this.settings.compaction?.idleCompactionEnabled ?? true,\n" +
  "        };";

const SETTINGS_REPLACEMENT =
  "            idleCompactionEnabled: this.settings.compaction?.idleCompactionEnabled ?? true,\n" +
  "            thresholdRatio: this.settings.compaction?.thresholdRatio,\n" +
  "            models: this.settings.compaction?.models ?? this.settings.compaction?.thresholdByModel,\n" +
  "        };";

const INDEX_HELPER_NEEDLE =
  "const DEFAULT_CONTEXT_WINDOW = 200_000;\n" +
  "const EMERGENCY_COMPACTION_INSTRUCTIONS = \"EMERGENCY:";

const INDEX_HELPER_REPLACEMENT =
  "const DEFAULT_CONTEXT_WINDOW = 200_000;\n" +
  "function compactionSettingsFor(ctx) {\n" +
  "    return { ...ctx.getCompactionSettings(), model: ctx.model };\n" +
  "}\n" +
  "const EMERGENCY_COMPACTION_INSTRUCTIONS = \"EMERGENCY:";

const INDEX_CALLS = [
  [
    "policy.shouldTriggerCompaction(usage, contextWindow, ctx.getCompactionSettings(), state.lastYield ?? undefined),",
    "policy.shouldTriggerCompaction(usage, contextWindow, compactionSettingsFor(ctx), state.lastYield ?? undefined),",
    "index idle-retry settings model",
  ],
  [
    "        const settings = ctx.getCompactionSettings();\n        if (policy.shouldStartSpeculativeCompaction",
    "        const settings = compactionSettingsFor(ctx);\n        if (policy.shouldStartSpeculativeCompaction",
    "index model-switch settings model",
  ],
  [
    "            const settings = ctx.getCompactionSettings();\n            if (settings.restorationEnabled",
    "            const settings = compactionSettingsFor(ctx);\n            if (settings.restorationEnabled",
    "index restoration settings model",
  ],
  [
    "        const settings = ctx.getCompactionSettings();\n        const pendingPromptTokens",
    "        const settings = compactionSettingsFor(ctx);\n        const pendingPromptTokens",
    "index before_agent_start settings model",
  ],
  [
    "        const settings = ctx.getCompactionSettings();\n        if (idle.shouldRunIdleCompaction",
    "        const settings = compactionSettingsFor(ctx);\n        if (idle.shouldRunIdleCompaction",
    "index idle settings model",
  ],
];

/** Per-model client threshold: settings.compaction.models / thresholdRatio, bypass 0.4–0.7 clamp. */
export function injectCompactionPolicy(source, hrefs = compactionPolicyHrefs()) {
  const thresholdHref = hrefs.threshold ?? compactionPolicyHrefs().threshold;
  let next = replaceOnce(
    source,
    "const MIN_ADAPTIVE_THRESHOLD_RATIO = 0.4;\n",
    `import { resolveClientCompactionThresholdRatio } from ${JSON.stringify(thresholdHref)};\nconst MIN_ADAPTIVE_THRESHOLD_RATIO = 0.4;\n${POLICY_HELPER}`,
    "policy configured threshold helper",
  );
  next = replaceOnce(
    next,
    "    return usage.tokens >= contextWindow * computeEffectiveThreshold(contextWindow, lastYield) * fraction;\n",
    "    return usage.tokens >= contextWindow * configuredOrAdaptiveThreshold(contextWindow, settings, lastYield) * fraction;\n",
    "policy speculative uses configured ratio",
  );
  return replaceOnce(
    next,
    "    return usage.tokens >= contextWindow * computeEffectiveThreshold(contextWindow, lastYield);\n",
    "    return usage.tokens >= contextWindow * configuredOrAdaptiveThreshold(contextWindow, settings, lastYield);\n",
    "policy trigger uses configured ratio",
  );
}

export function injectCompactionSettings(source) {
  return replaceOnce(source, SETTINGS_NEEDLE, SETTINGS_REPLACEMENT, "settings compaction threshold keys");
}

export function injectCompactionIndexThreshold(source) {
  let next = replaceOnce(source, INDEX_HELPER_NEEDLE, INDEX_HELPER_REPLACEMENT, "index compactionSettingsFor");
  for (const [needle, replacement, label] of INDEX_CALLS) {
    next = replaceOnce(next, needle, replacement, label);
  }
  return next;
}
