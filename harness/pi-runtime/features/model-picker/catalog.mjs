const PROVIDER_ORDER = ["openai-codex", "anthropic", "xai", "google-antigravity", "kiro", "cursor", "opencode"];
const MODEL_ORDER = {
  "openai-codex": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-daybreak-blue-latest"],
  anthropic: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  xai: ["grok-4.6"],
  "google-antigravity": ["gemini-3.8-flash"],
  kiro: ["gpt-5.6-sol", "claude-opus-5"],
  cursor: ["gpt-5.6-sol", "claude-fable-5-1", "claude-opus-5", "cursor-grok-4.6", "gemini-3.8-flash", "kimi-k3", "composer-2.5"],
  opencode: ["muse-spark-1.3-contributor-free"],
};

function rankedIndex(values, value) {
  const index = values.indexOf(value);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function sortModelItems(models) {
  return [...models].sort((a, b) => {
    const providerRank = rankedIndex(PROVIDER_ORDER, a.provider) - rankedIndex(PROVIDER_ORDER, b.provider);
    if (providerRank !== 0) return providerRank;
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) return providerCompare;
    const order = MODEL_ORDER[a.provider] ?? [];
    const modelRank = rankedIndex(order, a.id) - rankedIndex(order, b.id);
    return modelRank !== 0 ? modelRank : a.id.localeCompare(b.id);
  });
}

export function modelPickerLabel(item) {
  if (item.provider === "openai-codex" && item.id.startsWith("gpt-daybreak-blue-")) {
    return item.model?.name ?? item.id;
  }
  if (item.provider === "cursor" && item.id === "cursor-grok-4.6") {
    return "grok-4.6-fast";
  }
  if (item.id === "claude-fable-5-1") {
    return "Fable 5.1";
  }
  return item.id;
}
