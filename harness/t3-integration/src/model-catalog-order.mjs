import { supportedThinkingLevels } from "../../pi-runtime/features/thinking-levels/thinking-levels.mjs";

/** Same provider/model order and labels as Rubato CLI `/model`. */
export const PROVIDER_ORDER = [
  "openai-codex",
  "anthropic",
  "xai",
  "google-antigravity",
  "kiro",
  "cursor",
  "opencode",
];

export const MODEL_ORDER = {
  "openai-codex": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-daybreak-blue-latest"],
  anthropic: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  xai: ["grok-4.6"],
  "google-antigravity": ["gemini-3.8-flash"],
  kiro: ["gpt-5.6-sol", "claude-opus-5"],
  cursor: ["gpt-5.6-sol", "claude-fable-5-1", "claude-opus-5", "cursor-grok-4.6", "gemini-3.8-flash", "kimi-k3", "composer-2.5"],
  opencode: ["muse-spark-1.3-contributor-free"],
};

const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

// Keep aligned with harness/pi-runtime/features/service-tier/extension.mjs.
const CODEX_RESPONSES_API = "openai-codex-responses";
const SERVICE_TIER_APIS = new Set([
  "openai-codex-responses",
  "openai-responses",
  "openai-completions",
]);
const ANTHROPIC_FAST_MODEL_ID = /^claude-opus-(?:5|4-8)(?:-\d{8})?$/;

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
    return item.model?.name ?? item.name ?? item.id;
  }
  if (item.provider === "cursor" && item.id === "cursor-grok-4.6") return "grok-4.6-fast";
  if (item.id === "claude-fable-5-1") return "Fable 5.1";
  return item.id;
}

export function catalogSlugs() {
  return PROVIDER_ORDER.flatMap((provider) =>
    (MODEL_ORDER[provider] ?? []).map((id) => `${provider}/${id}`),
  );
}

export function isPickerModel(item, current = null) {
  if (item.provider === "openai") return false;
  if (current && current.provider === item.provider && current.id === item.id) return true;
  return (MODEL_ORDER[item.provider] ?? []).includes(item.id);
}

export function modelSupportsFast(model) {
  if (model?.api === CODEX_RESPONSES_API) return true;
  if (model?.provider === "xai" && SERVICE_TIER_APIS.has(model.api)) return true;
  if (model?.api !== "anthropic-messages") return false;
  if (model.provider !== "anthropic" && !/api\.anthropic\.com/.test(String(model.baseUrl ?? ""))) return false;
  return ANTHROPIC_FAST_MODEL_ID.test(String(model.upstreamModelId ?? model.id ?? "").toLowerCase());
}

export function optionDescriptorsFor(item) {
  const descriptors = [];
  const levels = supportedThinkingLevels(item).filter((level) => level !== "off");
  if (levels.length > 0) {
    const current = levels.includes("medium") ? "medium" : levels[0];
    descriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: levels.map((id) => ({
        id,
        label: EFFORT_LABELS[id] ?? id,
        ...(id === current ? { isDefault: true } : {}),
      })),
      currentValue: current,
    });
  }
  if (modelSupportsFast(item)) {
    descriptors.push({
      id: "fastMode",
      label: "Fast",
      type: "boolean",
      currentValue: false,
    });
  }
  return descriptors.length > 0 ? { optionDescriptors: descriptors } : null;
}

export function applySelectionOptions(options = []) {
  let thinking;
  let fast;
  for (const option of options) {
    if ((option.id === "thinking" || option.id === "reasoningEffort") && typeof option.value === "string") {
      thinking = option.value;
      continue;
    }
    if (option.id === "fastMode" && typeof option.value === "boolean") {
      fast = option.value;
      continue;
    }
    if (option.id === "serviceTier" && typeof option.value === "string") {
      fast = option.value === "fast" || option.value === "priority";
      continue;
    }
    throw new Error(`Unsupported Pi option: ${option.id}`);
  }
  return { thinking, fast };
}

export function catalogForPicker(models, current = null) {
  const visible = models.filter((item) => isPickerModel(item, current));
  return sortModelItems(visible).map((item) => ({
    ...item,
    name: modelPickerLabel(item),
    capabilities: optionDescriptorsFor(item),
  }));
}
