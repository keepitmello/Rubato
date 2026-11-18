import { supportedThinkingLevels } from "../../pi-runtime/features/thinking-levels/thinking-levels.mjs";
import {
  CODEX_ULTRAFAST_MODEL_IDS,
  PRODUCT_MODEL_ORDER,
  PRODUCT_PROVIDER_ORDER,
  admitProductCatalogItems,
  catalogSlugs,
  productCatalogBaseId,
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

/** The picker's name for a `provider/id` model plus its effort, e.g. "Opus 5.5 · High". */
export function modelDisplayLabel(model, effort) {
  if (typeof model !== "string" || !model.trim()) return undefined;
  const slash = model.indexOf("/");
  const item = slash === -1 ? { id: model } : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  const name = productCatalogLabel(item);
  if (typeof effort !== "string" || !effort.trim()) return name;
  return `${name} · ${EFFORT_LABELS[effort] ?? effort}`;
}

// Keep aligned with harness/pi-runtime/features/service-tier/extension.mjs.
const CODEX_RESPONSES_API = "openai-codex-responses";
const SERVICE_TIER_APIS = new Set([
  "openai-codex-responses",
  "openai-responses",
  "openai-completions",
]);
// 5-5 가 5 보다 앞에 온다 — 아니면 `claude-opus-5-5` 가 `5` 로만 매칭되고 꼬리에서 죽는다.
// Fable 은 5.2 만 Fast 를 받는다 (공식 가격표 Fast mode 절, 2026-11-10).
const ANTHROPIC_FAST_MODEL_ID = /^claude-(?:opus-(?:5-5|5|4-8)|fable-5-2)(?:-\d{8})?$/;

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
  const raw = String(model.upstreamModelId ?? model.id ?? "").toLowerCase();
  const wireId = productCatalogBaseId(raw);
  return ANTHROPIC_FAST_MODEL_ID.test(wireId);
}

/** Mirrors `supportsUltrafastMode` in the service-tier extension; both read the catalog's list. */
export function modelSupportsUltrafast(model) {
  if (model?.api !== CODEX_RESPONSES_API) return false;
  const wireId = productCatalogBaseId(String(model.upstreamModelId ?? model.id ?? ""));
  return CODEX_ULTRAFAST_MODEL_IDS.includes(wireId);
}

/** Service tiers a picked option can ask for. `default` means neither Fast nor Ultrafast. */
export const SERVICE_TIERS = Object.freeze({ default: "default", fast: "priority", ultrafast: "ultrafast" });

// Same ids and labels T3 gives Codex's own `serviceTier` select, so its trigger reads "Ultrafast".
const SERVICE_TIER_OPTIONS = Object.freeze([
  Object.freeze({ id: SERVICE_TIERS.default, label: "Normal", isDefault: true }),
  Object.freeze({ id: SERVICE_TIERS.fast, label: "Fast" }),
  Object.freeze({ id: SERVICE_TIERS.ultrafast, label: "Ultrafast" }),
]);

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
  if (modelSupportsUltrafast(item)) {
    descriptors.push({
      id: "serviceTier",
      label: "Speed",
      type: "select",
      options: SERVICE_TIER_OPTIONS.map((option) => ({ ...option })),
      currentValue: SERVICE_TIERS.default,
    });
  } else if (modelSupportsFast(item)) {
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
  let tier;
  for (const option of options) {
    if ((option.id === "thinking" || option.id === "reasoningEffort") && typeof option.value === "string") {
      thinking = option.value;
      continue;
    }
    if (option.id === "fastMode" && typeof option.value === "boolean") {
      tier = option.value ? SERVICE_TIERS.fast : SERVICE_TIERS.default;
      continue;
    }
    if (option.id === "serviceTier" && typeof option.value === "string") {
      tier = option.value === SERVICE_TIERS.ultrafast
        ? SERVICE_TIERS.ultrafast
        : option.value === "fast" || option.value === SERVICE_TIERS.fast ? SERVICE_TIERS.fast : SERVICE_TIERS.default;
      continue;
    }
    throw new Error(`Unsupported Pi option: ${option.id}`);
  }
  return { thinking, tier, fast: tier === undefined ? undefined : tier === SERVICE_TIERS.fast };
}

/**
 * The `/fast` and `/ultrafast` prompts that move the engine to the picked tier. T3 sends the
 * picker on every turn, so the picker is the answer; Pi remembers the tier per model, so compare
 * with what Pi reports (`get_service_tier`) rather than with the last value sent.
 *
 * - `engine` is that report, or undefined for an engine that predates it; then `lastFast`, the
 *   last Fast value sent, stands in and an unknown value is sent again.
 * - A model Pi cannot serve fast is already off; `/fast` there only warns.
 * - `/ultrafast` goes only to an engine that reports the model serves it. An engine without the
 *   command would hand the text to the model as a message.
 */
export function serviceTierPrompts(engine, tier, lastFast) {
  if (tier === undefined) return [];
  if (engine && engine.supported !== true) return [];
  const fast = engine ? engine.active === true : lastFast;
  const ultrafast = engine?.ultrafast === true;
  if (tier === SERVICE_TIERS.ultrafast && engine?.ultrafastSupported === true) {
    return ultrafast ? [] : ["/ultrafast on"];
  }
  if (tier === SERVICE_TIERS.fast) return fast === true ? [] : ["/fast on"];
  if (ultrafast) return ["/ultrafast off"];
  return fast === false ? [] : ["/fast off"];
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
