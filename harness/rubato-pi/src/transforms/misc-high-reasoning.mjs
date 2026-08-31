import { replaceOnce } from "./misc-replace.mjs";

export function isHighReasoningUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/high-reasoning-warning.js");
}

/**
 * Series #6: shouldWarnHighReasoning is always false.
 * Also restores the trailing newline the patch added at EOF.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectHighReasoning(source) {
  let next = replaceOnce(
    source,
    `export function shouldWarnHighReasoning(model, thinkingLevel) {
    return (thinkingLevel === "xhigh" || thinkingLevel === "max") && isSensitiveHighReasoningModel(model);
}`,
    `export function shouldWarnHighReasoning(model, thinkingLevel) {
    return false;
}`,
    "shouldWarnHighReasoning",
  );
  return replaceOnce(
    next,
    "//# sourceMappingURL=high-reasoning-warning.js.map",
    "//# sourceMappingURL=high-reasoning-warning.js.map\n",
    "high-reasoning eof newline",
  );
}
