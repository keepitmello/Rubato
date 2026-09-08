import { hasCredentialHeaders, hasHeader } from "../auth/headers.js";
export function resolveOpenAIClientAuth(provider, apiKey, headers) {
    if (apiKey)
        return { apiKey, headers };
    if (!hasCredentialHeaders(headers))
        throw new Error(`No API key for provider: ${provider}`);
    if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) {
        return { apiKey: "unused", headers };
    }
    return {
        apiKey: "unused",
        headers: { Authorization: null, ...headers },
    };
}
