// provider-overlay / session-defaults 가 끄는 foreign id 목록.
//
// 예전에는 `@earendil-works/pi-ai/providers/all` 을 올려 constructor 까지 돌렸다.
// 그 배럴은 프로바이더 구현 40개를 정적 import 해서, 세션 기본값만 확인해도
// 기동 그래프가 한 덩어리가 됐다. id 만 필요하므로 설치본에서 뽑은 스냅샷을
// 정적으로 두고, 핀이 바뀌면 provider-ids.test.mjs 가 어긋난다.
export const SUPPORTED_PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "xai",
  "anthropic",
  "cursor",
  "kiro",
  "google-antigravity",
]);

/**
 * Senpi 2026.8.22 의 `getBuiltinProviders()` ∪ `builtinProviders().map(p => p.id)`.
 * `getBuiltinProviders()` 는 generated catalog 키만 보고 cursor/ollama/radius
 * 같은 credential-only lane 을 빠뜨리므로 둘을 합친 값이다.
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
