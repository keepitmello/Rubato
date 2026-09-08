const CREDENTIAL_HEADER_SUFFIXES = [
    "api-key",
    "api-token",
    "auth-token",
    "access-token",
    "authorization",
    "client-secret",
];
export function isCredentialHeaderName(name) {
    const normalized = name.toLowerCase();
    return CREDENTIAL_HEADER_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`-${suffix}`));
}
export function hasHeader(headers, name) {
    if (!headers)
        return false;
    const value = effectiveHeaders(headers).get(name.toLowerCase());
    return typeof value === "string" && value.trim().length > 0;
}
export function hasCredentialHeaders(headers) {
    if (!headers)
        return false;
    for (const [name, value] of effectiveHeaders(headers)) {
        if (!isCredentialHeaderName(name) || typeof value !== "string")
            continue;
        const normalized = value.trim();
        if (!normalized)
            continue;
        if (name.endsWith("authorization") && /^(?:basic|bearer)\s*$/i.test(normalized))
            continue;
        return true;
    }
    return false;
}
function effectiveHeaders(headers) {
    const effective = new Map();
    for (const [name, value] of Object.entries(headers)) {
        effective.set(name.toLowerCase(), value ?? null);
    }
    return effective;
}
