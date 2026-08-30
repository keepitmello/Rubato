import { pathToFileURL } from "node:url";
import { senpiNested } from "./engine-paths.mjs";

// provider-overlay 가 끌어오는 pi-ai index.js(createProvider) 없이
// disabledProviders 계산에 필요한 id 만 모은다. 세션 기본값을 쓸 때마다
// 프로바이더 구현을 컴파일하지 않으려고 갈라 둔 파일이다.
const { builtinProviders, getBuiltinProviders } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/providers/all.js")).href
);

/**
 * Rubato 가 제품으로 지원하는 provider. FX bridge 삭제 뒤로 이것이 **유일한 권위**다.
 *
 * 예전에는 두 개념이 갈라져 있었다: 이 정적 목록은 "제품 계약"이었고, 활성 등록의
 * 권위는 bridge catalog 에서 유도한 `ourProviderIds(catalog)` 였다. 갈라 둘 이유가
 * catalog 자신이었다 — 살아 있는 bridge 가 우리가 모르는 provider 를 열 수 있었으므로
 * 그때의 실제 목록을 런타임에 물어야 했다.
 *
 * 이제 물을 곳이 없고, 등록하는 것은 pinned native factory 뿐이다. 목록과 실제가
 * 어긋날 수 있는 자리가 사라졌으므로 두 개념을 하나로 둔다.
 */
export const SUPPORTED_PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "xai",
  "anthropic",
  "cursor",
  "kiro",
  "google-antigravity",
]);

/**
 * Built-in pi-ai providers the model picker must never show. A provider id we did not register
 * ourselves is a direct-vendor lane with no credentials behind it. Ids we do register
 * (anthropic, openai-codex, xai, cursor, kiro, google-antigravity) stay: our registration
 * replaced them.
 */
export function builtinProviderIds() {
  // getBuiltinProviders() only lists ids present in the generated catalog, which misses
  // credential-only lanes like cursor/ollama/radius. Union both so nothing survives.
  return [...getBuiltinProviders(), ...builtinProviders().map((provider) => provider.id)];
}

export function foreignProviderIds(builtinIds) {
  const ours = new Set(SUPPORTED_PROVIDER_IDS);
  return [...new Set(builtinIds)].filter((id) => typeof id === "string" && id.length > 0 && !ours.has(id));
}
