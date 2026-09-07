import { existsSync as existsSyncFs, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "./defaults.mjs";
import { SUPPORTED_PROVIDER_IDS, builtinProviderIds, foreignProviderIds } from "./provider-ids.mjs";

export function settingsPath(agentDir) {
  return join(agentDir, "settings.json");
}

export function modelsPath(agentDir) {
  return join(agentDir, "models.json");
}

/**
 * 끄는 built-in OAuth extension.
 *
 * `cursor-cli-oauth` 는 real `cursor-agent` binary 를 띄우는 별개 lane 이고, native
 * Connect-RPC 와 동시에 노출하지 않는다(설계). 그런데 이것을 끄지 않으면 그 lane 의
 * catalog 가 **우리 모델 id 를 가린다** — `gemini-3.8-flash` 를 `input: ["text"]` 로 들고
 * 있어서, 같은 id 인 Antigravity 모델이 이미지 능력을 잃고 도구 결과 변환에서 죽는다.
 *
 * 시험이 이 목록을 다시 적지 않게 내보낸다. 실 세션과 다른 구성을 검증하면 그 검증은
 * 실 세션에 대해 아무것도 말하지 않는다.
 */
export const DISABLED_OAUTH_EXTENSIONS = ["claude-sdk-oauth", "cursor-cli-oauth"];

/**
 * 끄는 built-in 웹 검색 extension.
 *
 * `anthropic-web-search` 는 벤더 서버가 직접 도는 `web_search` 도구를 붙이고 시스템
 * 프롬프트에 그 사용법 문단까지 얹는다. 그 경로는 우리가 통제하지 못하는 축을 둘
 * 들여온다: 검색 실행이 모델 벤더의 과금·정책에 묶이고, 결과가 `encrypted_content`
 * 를 실은 provider-native 블록으로 대화에 남아 다른 모델로 갈아탈 때 replay 대상이
 * 된다. 웹은 Aside 로 간다 — 로그인 세션과 차단 우회까지 한 경로가 맡는다.
 *
 * `websearch` 를 함께 끄는 이유는 그것이 남으면 **거짓말을 하기 때문**이다. 그 확장은
 * `anthropic-web-search` 가 켜져 있다고 보고(판정이 env 만 읽는다) "provider 네이티브가
 * 처리한다"는 안내를 돌려주는데, 네이티브를 끈 뒤에는 아무도 처리하지 않는다. 게다가
 * 이 기기에는 `websearch.json` 이 없어 실제로 부를 수 있는 백엔드도 없다.
 *
 * `webfetch` 는 남긴다. URL 하나를 가져오는 것은 브라우저를 띄울 값이 아니다.
 */
export const DISABLED_WEB_SEARCH_EXTENSIONS = ["anthropic-web-search", "websearch"];

/** settings.json 에 적히는 전체 목록. 두 갈래를 한 곳에서 합친다. */
export const DISABLED_BUILTIN_EXTENSIONS = [...DISABLED_OAUTH_EXTENSIONS, ...DISABLED_WEB_SEARCH_EXTENSIONS];

/** Subtracted from the model cache TTL so a foreground wait never straddles expiry. */
export const PROMPT_CACHE_SAFETY_BUFFER_SECONDS = 300;

function promptCacheDefaults(current) {
  const existing =
    current.promptCache && typeof current.promptCache === "object" && !Array.isArray(current.promptCache)
      ? current.promptCache
      : {};
  // Policy-owned keys stay current. Other user subkeys (keepAlive, goalBackstop, …) survive.
  return {
    ...existing,
    cacheAwareTimeouts: true,
    safetyBufferSeconds: PROMPT_CACHE_SAFETY_BUFFER_SECONDS,
  };
}

function promptCacheLooksCurrent(current) {
  return (
    current.promptCache?.cacheAwareTimeouts === true &&
    current.promptCache?.safetyBufferSeconds === PROMPT_CACHE_SAFETY_BUFFER_SECONDS
  );
}

function readJson(path, { exists, readFile }) {
  if (!exists(path)) return {};
  try {
    const parsed = JSON.parse(readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function settingsLookCurrent(current) {
  if (!current || typeof current !== "object") return false;
  if (typeof current.defaultProvider !== "string" || current.defaultProvider.length === 0) return false;
  if (typeof current.defaultModel !== "string" || current.defaultModel.length === 0) return false;
  if (current.tips !== false) return false;
  if (typeof current.hideThinkingBlock !== "boolean") return false;
  if (!Array.isArray(current.disabledBuiltinExtensions)) return false;
  if (!DISABLED_BUILTIN_EXTENSIONS.every((id) => current.disabledBuiltinExtensions.includes(id))) return false;
  if (current.retry?.maxRetries == null) return false;
  if (current.retry?.modelFallback == null) return false;
  if (!promptCacheLooksCurrent(current)) return false;
  return true;
}

export function modelsLookCurrent(current) {
  if (!current || typeof current !== "object") return false;
  if (!Array.isArray(current.disabledProviders) || current.disabledProviders.length === 0) return false;
  if (!current.disabledProviders.includes("vercel-ai-gateway")) return false;
  return !SUPPORTED_PROVIDER_IDS.some((id) => current.disabledProviders.includes(id));
}

export function sessionDefaultsLookCurrent(
  agentDir,
  { exists = existsSyncFs, readFile = readFileSync } = {},
) {
  return (
    settingsLookCurrent(readJson(settingsPath(agentDir), { exists, readFile })) &&
    modelsLookCurrent(readJson(modelsPath(agentDir), { exists, readFile }))
  );
}

export function ensureSessionDefaults(
  agentDir,
  { exists = existsSyncFs, readFile = readFileSync, writeFile = writeFileSync } = {},
) {
  const path = settingsPath(agentDir);
  const current = readJson(path, { exists, readFile });
  const models = readJson(modelsPath(agentDir), { exists, readFile });
  if (settingsLookCurrent(current) && modelsLookCurrent(models)) {
    return current;
  }
  const disabled = new Set([
    ...(current.disabledBuiltinExtensions ?? []),
    ...DISABLED_BUILTIN_EXTENSIONS,
  ]);
  const next = {
    ...current,
    defaultProvider: current.defaultProvider ?? DEFAULT_PROVIDER,
    defaultModel: current.defaultModel ?? DEFAULT_MODEL_ID,
    // true 는 "안 보여준다" 가 아니라 "접어 둔다" 는 뜻이다. 렌더러는
    // hideThinkingBlock && !thinkingExpanded 로 판정하므로, true 여야 라벨을
    // 눌러 펴고 그 안에서 사고가 흐른다. false 로 두면 접기 자체가 사라져
    // 산문이 본문에 그대로 쏟아진다.
    hideThinkingBlock: current.hideThinkingBlock ?? true,
    // 기본 3회(2+4+8초)는 provider 가 잠깐 흔들리는 경우를 못 덮는다. 5회면 약
    // 62초까지 버틴다. 사용자가 적어 둔 값은 건드리지 않는다.
    //
    // modelFallback 은 엔진 기본이 true 다(senpi retry-fallback/settings.js).
    // 켜져 있으면 거절(refusal)을 만났을 때 같은 모델로 재시도하는 대신 체인의
    // 다음 모델로 갈아타고, 그 전환은 pinned 라 쿨다운 뒤에도 안 돌아온다 —
    // 사용자가 고른 모델이 조용히 바뀐 채로 세션이 이어진다. 우리는 거기서
    // 턴을 멈추고 에러를 그대로 보여주는 쪽을 고른다.
    retry: { maxRetries: 5, modelFallback: false, ...current.retry },
    promptCache: promptCacheDefaults(current),
    tips: false,
    disabledBuiltinExtensions: [...disabled],
  };
  writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  ensureModelsConfig(agentDir, { exists, readFile, writeFile });
  return next;
}

/**
 * disabledProviders 는 계산된 값이지 사용자가 쌓아 올린 목록이 아니다. 예전에는
 * 기존 항목을 그대로 합치기만 해서, 한 번 disabled 로 박힌 id 는 나중에 우리
 * 프로바이더가 되어도 파일에 영원히 남았다 — openai-codex 가 피커에서 사라진
 * 정체가 그것이다. 그래서 우리 것으로 돌아온 id(ours)는 여기서 회수한다.
 */
export function mergeDisabledProviders(current, required, ours = []) {
  const reclaimed = new Set(ours);
  const existing = Array.isArray(current?.disabledProviders) ? current.disabledProviders : [];
  return [...new Set([...existing, ...required])].filter(
    (id) => typeof id === "string" && id.length > 0 && !reclaimed.has(id),
  );
}

export function ensureModelsConfig(
  agentDir,
  { exists = existsSyncFs, readFile = readFileSync, writeFile = writeFileSync } = {},
) {
  const path = modelsPath(agentDir);
  const current = exists(path) ? JSON.parse(readFile(path, "utf8")) : {};
  const providers =
    current.providers && typeof current.providers === "object" && !Array.isArray(current.providers)
      ? current.providers
      : {};
  const next = {
    ...current,
    providers,
    disabledProviders: mergeDisabledProviders(
      current,
      foreignProviderIds(builtinProviderIds()),
      SUPPORTED_PROVIDER_IDS,
    ),
  };
  writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
