function defaultOpenAiRemoteCompactionBaseUrl(model) {
  return model.api === "openai-codex-responses" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1";
}

function isTrustedOpenAiCodexBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl || "https://chatgpt.com/backend-api");
    if (url.protocol === "https:" && url.hostname === "chatgpt.com") return true;
    return ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function parseOpenAiRemoteCompactionIdentity(provider, api) {
  if (typeof provider === "string" && provider.length > 0 && api === "openai-responses") {
    return { provider, api };
  }
  if (provider === "openai-codex" && api === "openai-codex-responses") {
    return { provider, api };
  }
  return undefined;
}

export function isOpenAiRemoteCompactionModel(model) {
  const identity = parseOpenAiRemoteCompactionIdentity(model?.provider, model?.api);
  if (!identity || !model) return false;
  if (model.api === "openai-responses" && model.provider !== "openai") {
    if (model.compat?.supportsRemoteCompactionV2 !== true) return false;
  }
  return identity.api !== "openai-codex-responses" || isTrustedOpenAiCodexBaseUrl(model.baseUrl);
}

export function openAiRemoteCompactionEndpointPath(model) {
  return model.api === "openai-codex-responses" ? "codex/responses/compact" : "responses/compact";
}

export function openAiRemoteCompactionEndpointUrl(model) {
  const baseUrl = model.baseUrl || defaultOpenAiRemoteCompactionBaseUrl(model);
  return new URL(openAiRemoteCompactionEndpointPath(model), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}
