// provider-overlay / session-defaults 가 끄는 foreign id 목록.
//
// 예전에는 `@earendil-works/pi-ai/providers/all` 을 올려 constructor 까지 돌렸다.
// 그 배럴은 프로바이더 구현 40개를 정적 import 해서, 세션 기본값만 확인해도
// 기동 그래프가 한 덩어리가 됐다. id 만 필요하므로 설치본에서 뽑은 스냅샷을
// 정적으로 두고, 핀이 바뀌면 provider-ids.test.mjs 가 어긋난다.
import { SUPPORTED_PROVIDER_IDS } from "./provider-capabilities.mjs";
export { SUPPORTED_PROVIDER_IDS };

/**
 * stock Pi 의 `getBuiltinProviders()` ∪ `builtinProviders().map(p => p.id)`.
 * `getBuiltinProviders()` 는 generated catalog 키만 보고 cursor/ollama/radius
 * 같은 credential-only lane 을 빠뜨리므로 둘을 합친 값이다.
 *
 * 여기 없는 builtin 은 foreign 으로 분류돼 Rubato 프로바이더 표면으로 샌다.
 * 핀이 올라가 builtin 이 늘면(예: 0.86.1 의 `meta`) 이 목록이 먼저 어긋나고,
 * `test/unit/provider-ids.test.mjs` 가 그 차이를 지목한다.
 */
export const BUILTIN_PROVIDER_IDS = Object.freeze([
  "alibaba-token-plan",
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "cursor",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "meta",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "ollama",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "opengateway",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

export function builtinProviderIds() {
  return BUILTIN_PROVIDER_IDS;
}

export function foreignProviderIds(builtinIds = BUILTIN_PROVIDER_IDS) {
  const ours = new Set(SUPPORTED_PROVIDER_IDS);
  return [...new Set(builtinIds)].filter((id) => typeof id === "string" && id.length > 0 && !ours.has(id));
}

/** pi-ai 의 API-key provider. Codex OAuth(`openai-codex`)와 다른 과금이다. */
export const OPENAI_API_PROVIDER_ID = "openai";

export function isOpenAiApiProvider(providerId) {
  return providerId === OPENAI_API_PROVIDER_ID;
}

export function refuseOpenAiApiModel(model) {
  if (!isOpenAiApiProvider(model?.provider)) return;
  throw new Error("OpenAI API is disabled. Use openai-codex (ChatGPT OAuth), not the openai provider.");
}

/**
 * Builtin catalog 는 unregister 해도 다시 살아난다. disabledProviders 가 빠져도
 * `/model openai/...` 나 env 의 OPENAI_API_KEY 가 API 로 나가지 않게 요청을 끊는다.
 */
export function installOpenAiApiRefusal(pi) {
  if (typeof pi?.on !== "function") return;
  pi.on("model_select", (event) => {
    refuseOpenAiApiModel(event?.model);
  });
  pi.on("before_provider_request", (event, ctx) => {
    refuseOpenAiApiModel(ctx?.model ?? event?.model);
  });
}
