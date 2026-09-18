/** The single product catalog for every Rubato picker and spawn surface. */

import { shortModelLabel } from "./model-label.mjs";

export const PRODUCT_PROVIDER_ORDER = Object.freeze([
  "openai-codex",
  "anthropic",
  "xai",
  "google-antigravity",
  "kiro",
  "cursor",
  "opencode",
]);

export const PRODUCT_MODEL_ORDER = Object.freeze({
  "openai-codex": Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-daybreak-blue-latest"]),
  anthropic: Object.freeze([
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ]),
  xai: Object.freeze(["grok-4.6"]),
  "google-antigravity": Object.freeze(["gemini-3.8-flash"]),
  kiro: Object.freeze(["gpt-5.6-sol", "claude-opus-5"]),
  cursor: Object.freeze(["gpt-5.6-sol", "claude-fable-5-1", "claude-opus-5", "cursor-grok-4.6", "gemini-3.8-flash", "kimi-k3", "composer-2.5"]),
  opencode: Object.freeze(["muse-spark-1.3-contributor-free"]),
});

export const CURSOR_GROK_PRESENTED_ID = "cursor/cursor-grok-4.6";
export const CURSOR_GROK_DEFAULT_FAST_ID = "cursor/cursor-grok-4.6-high-fast";
export const CURSOR_GROK_LIVE_IDS = Object.freeze([
  CURSOR_GROK_DEFAULT_FAST_ID,
  "cursor/cursor-grok-4.6-medium-fast",
  "cursor/cursor-grok-4.6-low-fast",
  "cursor/cursor-grok-4.6-xhigh-fast",
  "cursor/cursor-grok-4.6-fast",
]);

const LAUNCH_BY_PRESENTED = Object.freeze({
  [CURSOR_GROK_PRESENTED_ID]: CURSOR_GROK_DEFAULT_FAST_ID,
});

const ALIASES_BY_PRESENTED = Object.freeze({
  [CURSOR_GROK_PRESENTED_ID]: Object.freeze([CURSOR_GROK_PRESENTED_ID, ...CURSOR_GROK_LIVE_IDS]),
});

const PRESENTED_BY_ALIAS = new Map(
  Object.entries(ALIASES_BY_PRESENTED).flatMap(([presented, aliases]) =>
    aliases.map((alias) => [alias, presented]),
  ),
);

function rankedIndex(values, value) {
  const index = values.indexOf(value);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

const SUB_SUFFIX = "-sub";

export function productCatalogBaseId(id) {
  return typeof id === "string" && id.endsWith(SUB_SUFFIX) ? id.slice(0, -SUB_SUFFIX.length) : id;
}

function catalogOrderIds(order) {
  return order.flatMap((id) => [id, `${id}${SUB_SUFFIX}`]);
}

export function catalogSlugs() {
  return PRODUCT_PROVIDER_ORDER.flatMap((provider) =>
    (PRODUCT_MODEL_ORDER[provider] ?? []).map((id) => `${provider}/${id}`),
  );
}

export function isProductCatalogRow(item) {
  if (item == null || item.provider === "openai") return false;
  const order = PRODUCT_MODEL_ORDER[item.provider] ?? [];
  return order.includes(item.id) || order.includes(productCatalogBaseId(item.id));
}

export function isProductCatalogSlug(model) {
  if (typeof model !== "string") return false;
  const identity = productCatalogIdentity(model);
  if (catalogSlugs().includes(identity)) return true;
  if (!identity.endsWith(SUB_SUFFIX)) return false;
  return catalogSlugs().includes(identity.slice(0, -SUB_SUFFIX.length));
}

export function admitProductCatalogItems(models, options = {}) {
  const seen = new Set();
  const admitted = [];
  for (const item of models) {
    if (item?.provider === "openai") continue;
    const slug = typeof item?.provider === "string" && typeof item.id === "string" ? `${item.provider}/${item.id}` : "";
    const presented = slug.length > 0 ? productCatalogIdentity(slug) : "";
    const catalogHit = presented.length > 0 && isProductCatalogSlug(presented) && productCatalogAliases(presented).includes(slug);
    if (!catalogHit && !options.keep?.(item)) continue;
    const row = catalogHit && presented !== slug
      ? { ...item, id: presented.slice(item.provider.length + 1) }
      : item;
    const key = `${row.provider}/${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    admitted.push(row);
  }
  return admitted;
}

export function sortProductCatalogItems(models) {
  return [...models].sort((a, b) => {
    const providerRank = rankedIndex(PRODUCT_PROVIDER_ORDER, a.provider) - rankedIndex(PRODUCT_PROVIDER_ORDER, b.provider);
    if (providerRank !== 0) return providerRank;
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) return providerCompare;
    const order = PRODUCT_MODEL_ORDER[a.provider] ?? [];
    const ranked = catalogOrderIds(order);
    const modelRank = rankedIndex(ranked, a.id) - rankedIndex(ranked, b.id);
    return modelRank !== 0 ? modelRank : a.id.localeCompare(b.id);
  });
}

export function productCatalogLabel(item) {
  if (typeof item.id === "string" && item.id.endsWith(SUB_SUFFIX)) {
    return `${productCatalogLabel({ ...item, id: item.id.slice(0, -SUB_SUFFIX.length) })} [sub]`;
  }
  // Lane suffixes that the short label drops on purpose: the footer renders them as separate
  // badges, but the picker has no badge column, so these rows would otherwise be
  // indistinguishable from their plain siblings.
  if (item.provider === "cursor" && item.id === "cursor-grok-4.6") return `${shortModelLabel(item.id)} fast`;
  if (item.id === "gemini-3.8-flash") return `${shortModelLabel(item.id)} Flash`;
  return shortModelLabel(item.id);
}

export function productCatalogIdentity(model) {
  return PRESENTED_BY_ALIAS.get(model) ?? model;
}

export function productCatalogAliases(model) {
  const presented = productCatalogIdentity(model);
  return ALIASES_BY_PRESENTED[presented] ?? [presented];
}

export function launchProductModel(model) {
  return LAUNCH_BY_PRESENTED[productCatalogIdentity(model)] ?? model;
}

export function availableProductModelIds(entries) {
  const raw = new Set();
  for (const entry of entries ?? []) {
    if (typeof entry?.provider === "string" && typeof entry.id === "string") {
      raw.add(`${entry.provider}/${entry.id}`);
    }
  }
  return catalogSlugs().filter((slug) => productCatalogAliases(slug).some((alias) => raw.has(alias)));
}

export function expandProductCatalogVisibility(visible) {
  const next = new Set(visible);
  for (const slug of catalogSlugs()) {
    const aliases = productCatalogAliases(slug);
    if (!aliases.some((alias) => visible.has(alias))) continue;
    next.add(slug);
    for (const alias of aliases) next.add(alias);
  }
  return next;
}
