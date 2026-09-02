import { replaceOnce } from "./misc-replace.mjs";

const IMPORT_NEEDLE = 'import { operationSignal, raceWithAbortSignal } from "./utils/abort.js";\n';

const FUNCTION_NEEDLE = `export function getSupportedThinkingLevels(model) {
    if (!model.reasoning)
        return ["off"];
    return EXTENDED_THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null)
            return false;
        if (level === "xhigh")
            return supportsXhigh(model);
        if (level === "max")
            return supportsMax(model);
        return true;
    });
}`;

export function thinkingLevelsHref() {
  return new URL("../thinking-levels.mjs", import.meta.url).href;
}

export function isThinkingLevelsUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/models.js");
}

/**
 * Shift+Tab 칸을 모델 wire 단계에 맞춘다. `off`/`minimal` 은 넣지 않는다.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectThinkingLevels(source, href = thinkingLevelsHref()) {
  let next = replaceOnce(
    source,
    IMPORT_NEEDLE,
    `${IMPORT_NEEDLE}import { supportedThinkingLevels as rubatoSupportedThinkingLevels } from ${JSON.stringify(href)};\n`,
    "thinking levels import",
  );
  return replaceOnce(
    next,
    FUNCTION_NEEDLE,
    `export function getSupportedThinkingLevels(model) {
    return rubatoSupportedThinkingLevels(model, { supportsXhigh, supportsMax });
}`,
    "getSupportedThinkingLevels",
  );
}
