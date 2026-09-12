import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-ai";
const VERSION = "0.85.1";
const LEVELS_IMPORT = 'import { supportedThinkingLevels as rubatoSupportedThinkingLevels } from "./rubato-features/thinking-levels/thinking-levels.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[thinking-levels:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[thinking-levels:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[thinking-levels:" + label + "] expected pristine feature seam");
}

const IMPORT_BEFORE = 'import { operationSignal, raceWithAbortSignal } from "./utils/abort.js";\n';
const IMPORT_AFTER = 'import { operationSignal, raceWithAbortSignal } from "./utils/abort.js";\n' + LEVELS_IMPORT + '\n';

const FUNCTION_BEFORE = `export function getSupportedThinkingLevels(model) {\n    if (!model.reasoning)\n        return ["off"];\n    return EXTENDED_THINKING_LEVELS.filter((level) => {\n        const mapped = model.thinkingLevelMap?.[level];\n        if (mapped === null)\n            return false;\n        if (level === "xhigh" || level === "max")\n            return mapped !== undefined;\n        return true;\n    });\n}`;
const FUNCTION_AFTER = `export function getSupportedThinkingLevels(model) {\n    return rubatoSupportedThinkingLevels(model);\n}`;

export function patchThinkingLevels(source) {
  unpatched(source, LEVELS_IMPORT, "thinking-import");
  let next = replaceOnce(source, IMPORT_BEFORE, IMPORT_AFTER, "thinking-import");
  return replaceOnce(next, FUNCTION_BEFORE, FUNCTION_AFTER, "getSupportedThinkingLevels");
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/rubato-features/thinking-levels/thinking-levels.mjs",
    sourcePath: fileURLToPath(new URL("./thinking-levels.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "thinking-levels:models",
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/models.js",
    preimageSha256: "42610d47fe293d99f4b05b147971e181c7312ea47c9be2906a4803955276a8a4",
    apply: patchThinkingLevels,
  }),
]);

export const feature = Object.freeze({ id: "thinking-levels", patches, files });
export default feature;
