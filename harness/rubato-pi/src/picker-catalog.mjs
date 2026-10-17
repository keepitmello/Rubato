// 피커에 현재 쓰는 모델만 남긴다. 모델 정의는 만들지 않는다 — discovery/pin 에
// 없는 id 는 등장하지 않는다. getModels() 저장분은 그대로 두고 filterModels 만 줄인다.
//
// Cursor 일곱은 `cursor-picker.mjs` 가 소유한다 (Grok Fast 접힘이 앞에 있다).

import { readFileSync, statSync } from "node:fs";

export const XAI_PICKER_IDS = Object.freeze(["grok-4.7"]);

export const OPENCODE_PICKER_IDS = Object.freeze(["muse-spark-1.3-contributor-free"]);

export const VERTEX_PICKER_IDS = Object.freeze(["gemini-4-argon"]);

export const ANTHROPIC_PICKER_IDS = Object.freeze([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

// Codex Fast 는 피커 행이 아니라 `/fast` 토글이다. getModels() 저장분의 `-fast`
// 변형은 그대로 두고, 피커에만 base 를 올린다.
export const CODEX_PICKER_IDS = Object.freeze([
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-daybreak-blue-latest",
]);

/** Codex `[sub]` 는 Sol 과 Astra 만. Terra/Luna/Daybreak 는 한 계정으로만 고른다. */
export const CODEX_SUB_PICKER_IDS = Object.freeze(["gpt-6.1-sol", "gpt-6-astra"]);

/** Anthropic `[sub]` 는 Fable, Opus, Sonnet 만. Haiku 는 한 계정으로만 고른다. */
export const ANTHROPIC_SUB_PICKER_IDS = Object.freeze(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);

export const SUB_MODEL_SUFFIX = "-sub";
export const SUB2_MODEL_SUFFIX = "-sub2";

/**
 * 계정 행 꼬리마다 행을 붙일 모델. 명단이지 기본값이 아니다 — 여기 없는 프로바이더·꼬리는 행이 없다.
 * `[sub2]` 는 Anthropic 만 세 번째 계정을 쓴다.
 */
const ACCOUNT_LANE_PICKER_IDS = Object.freeze({
  [SUB_MODEL_SUFFIX]: Object.freeze({
    "openai-codex": CODEX_SUB_PICKER_IDS,
    anthropic: ANTHROPIC_SUB_PICKER_IDS,
  }),
  [SUB2_MODEL_SUFFIX]: Object.freeze({
    anthropic: ANTHROPIC_SUB_PICKER_IDS,
  }),
});

const ACCOUNT_LANE_SUFFIXES = Object.freeze(Object.keys(ACCOUNT_LANE_PICKER_IDS));

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

export function isSubModelId(id) {
  return typeof id === "string" && ACCOUNT_LANE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

export function cloneSubModels(models, suffix = SUB_MODEL_SUFFIX) {
  return models
    .filter((model) => !isSubModelId(model.id))
    .map((model) => ({
      ...model,
      id: `${model.id}${suffix}`,
      name: `${model.name ?? model.id} [${suffix.slice(1)}]`,
    }));
}

function subCopyBases(models, providerId, suffix) {
  const bases = models.filter((model) => !isSubModelId(model?.id));
  const allow = ACCOUNT_LANE_PICKER_IDS[suffix]?.[providerId];
  // Allowlist, not a fallthrough: `[sub]` is a curated pair of rows for the two providers we
  // actually run two accounts on. A provider that merely happens to carry a leftover second
  // credential slot (a re-login appends one) must not grow `[sub]` rows on its own.
  if (!allow) return [];
  return bases.filter((model) => allow.includes(model.id));
}

/**
 * 기본 계정 다음 계정들의 슬롯 이름. 순서가 곧 행 꼬리다: 0번은 `-sub`, 1번은 `-sub2`.
 * `sub`·`sub2` 로 이름 붙인 슬롯이 먼저고, 로그인이 붙인 `login-N` 은 번호 순서로 뒤에 선다.
 * auth-pool/runtime-pool.mjs `accountLaneSlotNames` 와 같은 규칙이다 — 하나를 바꾸면 둘 다 바꾼다.
 */
export function accountLaneSlotNames(slots) {
  const names = (Array.isArray(slots) ? slots : []).map((slot) => slot?.name).filter((name) => typeof name === "string");
  const named = ["sub", "sub2"].filter((name) => names.includes(name));
  const logins = names
    .filter((name) => /^login-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  return [...named, ...logins];
}

function credentialLaneSuffixes(credential) {
  const count = accountLaneSlotNames(credential?.accounts).length;
  return ACCOUNT_LANE_SUFFIXES.slice(0, count);
}

export function credentialHasSubAccount(credential) {
  return credentialLaneSuffixes(credential).length > 0;
}

/**
 * 저장된 자격증명을 동기로 읽는 함수를 만든다. `getModels()` 는 동기라 엔진이 넘겨주는
 * credential 이 없다 — 이 파일이 그 자리를 채운다. 파일이 바뀔 때만(mtime·크기) 다시 읽는다.
 *
 * 돌려주는 값: 그 프로바이더의 자격증명, 저장분이 없으면 `null`, 파일을 못 읽으면 `undefined`
 * (모름). 쓰는 도중이라 JSON 이 깨져 있으면 직전에 읽은 값을 그대로 쓴다.
 */
export function storedCredentialReader(authPath) {
  let cache;
  return (providerId) => {
    let stat;
    try {
      stat = statSync(authPath);
    } catch (error) {
      return error?.code === "ENOENT" ? null : cache?.data?.[providerId] ?? undefined;
    }
    if (!cache || cache.mtimeMs !== stat.mtimeMs || cache.size !== stat.size) {
      try {
        cache = { mtimeMs: stat.mtimeMs, size: stat.size, data: JSON.parse(readFileSync(authPath, "utf8")) };
      } catch {
        return cache?.data?.[providerId] ?? undefined;
      }
    }
    return cache.data?.[providerId] ?? null;
  };
}

function mergeById(models, extras) {
  const seen = new Set(models.map((model) => model.id));
  return [...models, ...extras.filter((model) => !seen.has(model.id))];
}

function laneCopies(models, providerId, suffixes) {
  return suffixes.flatMap((suffix) => cloneSubModels(subCopyBases(models, providerId, suffix), suffix));
}

/**
 * 두 번째 계정이 있으면 `[sub]`, 세 번째 계정이 있으면 `[sub2]` 행을 피커에 붙인다.
 * getModels 에도 같은 id 를 넣어 에이전트 스폰이 찾게 한다. 다만 **있는 계정만큼만** 넣는다.
 *
 * 엔진은 프로바이더를 등록할 때마다 getModels() 를 거르지 않고 "쓸 수 있는 모델" 스냅샷을
 * 먼저 만들고, 계정으로 거른 목록은 나중에 비동기로 덮어쓴다. T3 피커와 에이전트 모델 목록은
 * 그 사이 스냅샷을 읽는다 — 그래서 getModels 가 꼬리를 전부 넣으면 계정이 둘뿐인 기기에도
 * `[sub2]` 가 보이고, 고르면 "Account 'sub2' is unavailable" 로 실패했다(2026-10-13).
 * `readStoredCredential` 이 없거나 모른다(`undefined`)고 하면 꼬리를 전부 넣는다.
 */
export function withSubAccountCopies(provider, { readStoredCredential } = {}) {
  if (typeof provider?.getModels !== "function") return provider;
  const nativeGetModels = provider.getModels.bind(provider);
  const nativeFilter = provider.filterModels;
  const storedLaneSuffixes = () => {
    const credential = readStoredCredential?.(provider.id);
    return credential === undefined ? ACCOUNT_LANE_SUFFIXES : credentialLaneSuffixes(credential);
  };
  return {
    ...provider,
    getModels: () => {
      const models = nativeGetModels();
      const presented = nativeFilter ? nativeFilter(models, undefined) : models;
      return mergeById(models, laneCopies(presented, provider.id, storedLaneSuffixes()));
    },
    filterModels: (models, credential) => {
      const presented = nativeFilter ? nativeFilter(models, credential) : models;
      const kept = presented.filter((model) => !isSubModelId(model?.id));
      return [...kept, ...laneCopies(kept, provider.id, credentialLaneSuffixes(credential))];
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
