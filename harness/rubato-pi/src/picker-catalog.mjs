// 피커에 현재 쓰는 모델만 남긴다. 모델 정의는 만들지 않는다 — discovery/pin 에
// 없는 id 는 등장하지 않는다. getModels() 저장분은 그대로 두고 filterModels 만 줄인다.
//
// Cursor 일곱은 `cursor-picker.mjs` 가 소유한다 (Grok Fast 접힘이 앞에 있다).

export const XAI_PICKER_IDS = Object.freeze(["grok-4.6"]);

export const OPENCODE_PICKER_IDS = Object.freeze(["muse-spark-1.3-contributor-free"]);

export const ANTHROPIC_PICKER_IDS = Object.freeze([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
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

export function withPickerIds(provider, ids) {
  const nativeFilter = provider.filterModels;
  return {
    ...provider,
    filterModels: (models, credential) =>
      keepPickerIds(nativeFilter ? nativeFilter(models, credential) : models, ids),
  };
}
