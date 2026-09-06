import { replaceOnce } from "./misc-replace.mjs";

const DATE_NEEDLE = "    const date = new Date().toISOString().slice(0, 10);";
const DATE_REPLACEMENT = "    const date = (buildDynamicSystemPrompt.sessionDate ??= new Date().toISOString().slice(0, 10));";

export function isSessionDateUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/dynamic-prompt/build.js");
}

/**
 * Freeze `Current date:` for the life of the process.
 *
 * senpi rebuilds the dynamic system prompt on every turn. `new Date()` at UTC
 * midnight rewrites the cached prefix on every provider. Resolve the date once
 * on first build so request N stays a byte prefix of request N+1.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectSessionDate(source) {
  return replaceOnce(source, DATE_NEEDLE, DATE_REPLACEMENT, "session-date");
}
