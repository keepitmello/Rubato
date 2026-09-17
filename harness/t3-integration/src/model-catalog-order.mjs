import { supportedThinkingLevels } from "../../pi-runtime/features/thinking-levels/thinking-levels.mjs";
import {
  PRODUCT_MODEL_ORDER,
  PRODUCT_PROVIDER_ORDER,
  admitProductCatalogItems,
  catalogSlugs,
  productCatalogLabel,
  sortProductCatalogItems,
} from "../../../packages/model-core/src/product-model-catalog.mjs";

/** Re-export the product catalog; do not add a second list here. */
export const PROVIDER_ORDER = PRODUCT_PROVIDER_ORDER;
export const MODEL_ORDER = PRODUCT_MODEL_ORDER;
export { catalogSlugs, productCatalogLabel as modelPickerLabel, sortProductCatalogItems as sortModelItems };

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

export function isPickerModel(item, current = null) {
  return admitProductCatalogItems([item], {
    keep: () => current != null && current.provider === item.provider && current.id === item.id,
  }).length > 0;
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
  const visible = admitProductCatalogItems(models, {
    keep: (item) => current != null && current.provider === item.provider && current.id === item.id,
  });
  return sortProductCatalogItems(visible).map((item) => ({
    ...item,
    name: productCatalogLabel(item),
    capabilities: optionDescriptorsFor(item),
  }));
}
