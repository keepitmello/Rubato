// 피커에 현재 쓰는 모델만 남긴다. 모델 정의는 만들지 않는다 — discovery/pin 에
// 없는 id 는 등장하지 않는다. getModels() 저장분은 그대로 두고 filterModels 만 줄인다.
//
// Cursor 일곱은 `cursor-picker.mjs` 가 소유한다 (Grok Fast 접힘이 앞에 있다).

export const XAI_PICKER_IDS = Object.freeze(["grok-4.6"]);

export const OPENCODE_PICKER_IDS = Object.freeze(["muse-spark-1.3-contributor-free"]);

export const ANTHROPIC_PICKER_IDS = Object.freeze([
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);

// Codex Fast 는 피커 행이 아니라 `/fast` 토글이다. getModels() 저장분의 `-fast`
// 변형은 그대로 두고, 피커에만 base 를 올린다.
export const CODEX_PICKER_IDS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-daybreak-blue-latest",
]);

/** Codex `[sub]` 는 Sol 과 Astra 만. Terra/Luna/Daybreak 는 한 계정으로만 고른다. */
export const CODEX_SUB_PICKER_IDS = Object.freeze(["gpt-5.6-sol", "gpt-6-astra"]);

/** Anthropic `[sub]` 는 Fable 과 Opus 만. Sonnet/Haiku 는 한 계정으로만 고른다. */
export const ANTHROPIC_SUB_PICKER_IDS = Object.freeze(["claude-fable-5-1", "claude-opus-5"]);

const SUB_PICKER_IDS = Object.freeze({
  "openai-codex": CODEX_SUB_PICKER_IDS,
  anthropic: ANTHROPIC_SUB_PICKER_IDS,
});

export function keepPickerIds(models, ids) {
  if (!Array.isArray(models) || models.length === 0) return models;
  const order = [...ids];
  const want = new Set(order);
  const byId = new Map();
  for (const model of models) {
    if (want.has(model.id) && !byId.has(model.id)) byId.set(model.id, model);
  }
  return order.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

export const SUB_MODEL_SUFFIX = "-sub";

export function isSubModelId(id) {
  return typeof id === "string" && id.endsWith(SUB_MODEL_SUFFIX);
}

export function cloneSubModels(models) {
  return models
    .filter((model) => !isSubModelId(model.id))
    .map((model) => ({
      ...model,
      id: `${model.id}${SUB_MODEL_SUFFIX}`,
      name: `${model.name ?? model.id} [sub]`,
    }));
}

function subCopyBases(models, providerId) {
  const bases = models.filter((model) => !isSubModelId(model?.id));
  const allow = SUB_PICKER_IDS[providerId];
  // Allowlist, not a fallthrough: `[sub]` is a curated pair of rows for the two providers we
  // actually run two accounts on. A provider that merely happens to carry a leftover second
  // credential slot (a re-login appends one) must not grow `[sub]` rows on its own.
  if (!allow) return [];
  return bases.filter((model) => allow.includes(model.id));
}

export function credentialHasSubAccount(credential) {
  const slots = Array.isArray(credential?.accounts) ? credential.accounts : [];
  return slots.some((slot) => slot?.name === "sub" || slot?.name === "login-2");
}

function mergeById(models, extras) {
  const seen = new Set(models.map((model) => model.id));
  return [...models, ...extras.filter((model) => !seen.has(model.id))];
}

/** 두 번째 계정이 있으면 피커에 `[sub]` 행을 붙이고, getModels 에도 같은 id 를 넣어 에이전트 스폰이 찾게 한다. */
export function withSubAccountCopies(provider) {
  if (typeof provider?.getModels !== "function") return provider;
  const nativeGetModels = provider.getModels.bind(provider);
  const nativeFilter = provider.filterModels;
  return {
    ...provider,
    getModels: () => {
      const models = nativeGetModels();
      const presented = nativeFilter ? nativeFilter(models, undefined) : models;
      const bases = subCopyBases(presented, provider.id);
      return mergeById(models, cloneSubModels(bases));
    },
    filterModels: (models, credential) => {
      const presented = nativeFilter ? nativeFilter(models, credential) : models;
      const kept = presented.filter((model) => !isSubModelId(model?.id));
      const bases = subCopyBases(kept, provider.id);
      if (!credentialHasSubAccount(credential)) return kept;
      return [...kept, ...cloneSubModels(bases)];
    },
  };
}

export function withPickerIds(provider, ids) {
  const nativeFilter = provider.filterModels;
  return {
    ...provider,
    filterModels: (models, credential) =>
      keepPickerIds(nativeFilter ? nativeFilter(models, credential) : models, ids),
  };
}
