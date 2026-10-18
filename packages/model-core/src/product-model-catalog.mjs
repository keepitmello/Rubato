/** The single product catalog for every Rubato picker and spawn surface. */

import { shortModelLabel } from "./model-label.mjs";

export const PRODUCT_PROVIDER_ORDER = Object.freeze([
  "openai-codex",
  "anthropic",
  "xai",
  "google-antigravity",
  "google-vertex",
  "kiro",
  "cursor",
  "opencode",
  "b-ai",
  "opengateway",
  "nanogpt",
]);

/**
 * Cursor 의 Grok 행이 discovery 에서 오는 베이스 id.
 *
 * Cursor 는 4.7 부터 이 행을 `cursor-` 접두사 없이 내보낸다 (4.6 은 `cursor-grok-4.6`).
 * 네임스페이스가 Cursor 손에 있어서 우리가 정하지 못하므로, 값은 여기 한 곳에 두고
 * 표시 id·Fast 변형·라벨 판정이 전부 여기서 파생한다.
 */
export const CURSOR_GROK_BASE_ID = "grok-4.7";

export const PRODUCT_MODEL_ORDER = Object.freeze({
  "openai-codex": Object.freeze(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-daybreak-blue-latest"]),
  anthropic: Object.freeze([
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]),
  xai: Object.freeze(["grok-4.7"]),
  "google-antigravity": Object.freeze(["gemini-3.8-flash"]),
  "google-vertex": Object.freeze(["gemini-4-argon"]),
  kiro: Object.freeze(["gpt-5.6-sol", "claude-opus-5"]),
  cursor: Object.freeze(["gpt-5.6-sol", "claude-fable-5-1", "claude-opus-5", CURSOR_GROK_BASE_ID, "gemini-3.8-flash", "kimi-k3", "composer-2.5"]),
  opencode: Object.freeze(["muse-spark-1.3-contributor-free"]),
  "b-ai": Object.freeze(["deepseek-v4.1-flash"]),
  // OpenGateway 의 id 는 `제작사/모델` 이라 슬래시를 품는다. 슬러그는 첫 슬래시에서만 프로바이더를 가른다.
  opengateway: Object.freeze(["deepseek/deepseek-v4.1-flash-ultrafast"]),
  nanogpt: Object.freeze(["z-ai/glm-5.3-uncensored", "z-ai/glm-5.3-flash-uncensored"]),
});

export const CURSOR_GROK_PRESENTED_ID = `cursor/${CURSOR_GROK_BASE_ID}`;
export const CURSOR_GROK_DEFAULT_FAST_ID = `cursor/${CURSOR_GROK_BASE_ID}-high-fast`;
export const CURSOR_GROK_LIVE_IDS = Object.freeze([
  CURSOR_GROK_DEFAULT_FAST_ID,
  `cursor/${CURSOR_GROK_BASE_ID}-medium-fast`,
  `cursor/${CURSOR_GROK_BASE_ID}-low-fast`,
  `cursor/${CURSOR_GROK_BASE_ID}-xhigh-fast`,
  `cursor/${CURSOR_GROK_BASE_ID}-fast`,
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

/**
 * 같은 모델을 다른 계정으로 부르는 행의 꼬리. `-sub` 는 두 번째, `-sub2` 는 세 번째 계정이다.
 * 모델이 다른 게 아니라 계정이 다른 것이라, 꼬리를 떼면 원래 모델 id 가 된다.
 */
export const ACCOUNT_LANE_SUFFIXES = Object.freeze(["-sub", "-sub2"]);

export function accountLaneSuffix(id) {
  if (typeof id !== "string") return undefined;
  return ACCOUNT_LANE_SUFFIXES.find((suffix) => id.endsWith(suffix));
}

export function productCatalogBaseId(id) {
  const suffix = accountLaneSuffix(id);
  return suffix ? id.slice(0, -suffix.length) : id;
}

function catalogOrderIds(order) {
  return order.flatMap((id) => [id, ...ACCOUNT_LANE_SUFFIXES.map((suffix) => `${id}${suffix}`)]);
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
  if (!accountLaneSuffix(identity)) return false;
  return catalogSlugs().includes(productCatalogBaseId(identity));
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
    const accountRank = Number(Boolean(accountLaneSuffix(a.id))) - Number(Boolean(accountLaneSuffix(b.id)));
    if (accountRank !== 0) return accountRank;
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
  const lane = accountLaneSuffix(item.id);
  if (lane) {
    return `${productCatalogLabel({ ...item, id: productCatalogBaseId(item.id) })} [${lane.slice(1)}]`;
  }
  // Lane suffixes that the short label drops on purpose: the footer renders them as separate
  // badges, but the picker has no badge column, so these rows would otherwise be
  // indistinguishable from their plain siblings.
  if (item.provider === "cursor" && item.id === CURSOR_GROK_BASE_ID) return `${shortModelLabel(item.id)} fast`;
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
  const ids = [];
  const accountIds = [];
  for (const slug of catalogSlugs()) {
    if (productCatalogAliases(slug).some((alias) => raw.has(alias))) ids.push(slug);
    for (const suffix of ACCOUNT_LANE_SUFFIXES) {
      if (raw.has(`${slug}${suffix}`)) accountIds.push(`${slug}${suffix}`);
    }
  }
  return [...ids, ...accountIds];
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
