import { replaceOnce } from "./misc-replace.mjs";

const CONST_NEEDLE = "export const PROMPT_CACHE_TTL_SHORT_SECONDS = 300;\nexport const PROMPT_CACHE_TTL_LONG_SECONDS = 3600;\nexport function isAnthropicApiBaseUrl(baseUrl) {";

const CONST_REPLACEMENT = "export const PROMPT_CACHE_TTL_SHORT_SECONDS = 300;\nexport const PROMPT_CACHE_TTL_LONG_SECONDS = 3600;\n/** GPT-5.6+ Responses/Codex prompt-cache contract: 30 minutes. */\nexport const PROMPT_CACHE_TTL_GPT56_SECONDS = 1800;\nexport function isAnthropicApiBaseUrl(baseUrl) {";

const HELPERS_NEEDLE = "export function resolvePromptCacheTtlSeconds(model, env) {";

const HELPERS_REPLACEMENT = "function gptVersionFromModelId(modelId) {\n    const match = String(modelId).toLowerCase().match(/(?:^|[/.:_])gpt-(\\d+)(?:\\.(\\d+))?(?:$|[^a-z0-9])/);\n    if (!match)\n        return undefined;\n    return { major: Number(match[1]), minor: match[2] === undefined ? 0 : Number(match[2]) };\n}\n/** GPT-5.6 and later ids on OpenAI Responses / Codex Responses. */\nfunction isGpt56OrLaterModelId(modelId) {\n    const version = gptVersionFromModelId(modelId);\n    return !!version && (version.major > 5 || (version.major === 5 && version.minor >= 6));\n}\nexport function resolvePromptCacheTtlSeconds(model, env) {";

const OPENAI_NEEDLE = "        case \"openai-codex-responses\":\n        case \"azure-openai-responses\": {\n            const retention = resolveOpenAIResponsesCacheRetention(model.cacheRetention, env);\n            return retention === \"none\" ? undefined : PROMPT_CACHE_TTL_SHORT_SECONDS;\n        }";

const OPENAI_REPLACEMENT = "        case \"openai-codex-responses\":\n        case \"azure-openai-responses\": {\n            const retention = resolveOpenAIResponsesCacheRetention(model.cacheRetention, env);\n            if (retention === \"none\")\n                return undefined;\n            // Azure stays on the 5-minute budget until its cache contract is verified.\n            if ((model.api === \"openai-responses\" || model.api === \"openai-codex-responses\") &&\n                isGpt56OrLaterModelId(model.id))\n                return PROMPT_CACHE_TTL_GPT56_SECONDS;\n            return PROMPT_CACHE_TTL_SHORT_SECONDS;\n        }";

export function isPromptCacheTtlUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/utils/prompt-cache-ttl.js");
}

/**
 * Series 20260829-1305Z-gpt56-prompt-cache-ttl: GPT-5.6+ TTL = 1800s.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectPromptCacheTtl(source) {
  let next = replaceOnce(source, CONST_NEEDLE, CONST_REPLACEMENT, "prompt-cache-ttl const");
  next = replaceOnce(next, HELPERS_NEEDLE, HELPERS_REPLACEMENT, "prompt-cache-ttl helpers");
  return replaceOnce(next, OPENAI_NEEDLE, OPENAI_REPLACEMENT, "prompt-cache-ttl openai branch");
}
