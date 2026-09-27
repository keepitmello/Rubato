// B.AI 키는 DeepSeek 전용이다. 이 파일이 그 경계의 유일한 정본이다.
//
// 2026-09-23~25 에 같은 B.AI 키로 Opus 5.5 가 과금돼 크레딧이 하루 만에 바닥났다.
// 어디서 새었든 b.ai 로 나가는 요청이 DeepSeek 이 아니면 요청을 만들기 전에 멈춘다.
// 판정은 provider 이름이 아니라 **실제로 나갈 주소**로 한다 — models.json 에서
// anthropic 의 baseUrl 을 b.ai 로 바꿔도, b-ai 목록에 claude 를 넣어도 같은 자리에서
// 걸린다.
//
// 소비자: `session-defaults.mjs`(b-ai 등록과 models.json 정리)와 pi-ai
// `dist/api/lazy.js` 패치(모든 HTTP API 호출의 공통 입구). 의존성을 두지 않는다 —
// 엔진 안 `dist/rubato-features/providers/src/` 로 그대로 복사된다.

export const BAI_PROVIDER_ID = "b-ai";
export const BAI_BASE_URL = "https://api.b.ai/v1";
export const BAI_FLASH_MODEL_ID = "deepseek-v4.1-flash";

/** b.ai 호스트(와 그 하위 도메인)인지. 주소를 못 읽으면 b.ai 가 아니다. */
export function isBaiEndpoint(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "b.ai" || host.endsWith(".b.ai");
}

/** DeepSeek 계열 모델 id 인지. 세대가 바뀌어도 이 계열이면 허용한다. */
export function isBaiAllowedModelId(id) {
  return typeof id === "string" && /^deepseek-/i.test(id);
}

/** 이 모델로 요청을 보내면 b.ai 에서 DeepSeek 아닌 과금이 나는지. */
export function baiRouteViolation(model) {
  if (!isBaiEndpoint(model?.baseUrl)) return undefined;
  if (isBaiAllowedModelId(model?.id)) return undefined;
  return `B.AI key is DeepSeek-only: refused ${model?.provider ?? "?"}/${model?.id ?? "?"} → ${model.baseUrl}`;
}

export function assertBaiRoute(model) {
  const violation = baiRouteViolation(model);
  if (violation) throw new Error(violation);
}
