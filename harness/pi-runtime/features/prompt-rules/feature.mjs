import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "instructions.mjs",
  "todo.mjs",
  "THIRD_PARTY_NOTICES.md",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/prompt-rules/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const promptRulesFeature = Object.freeze({ id: "prompt-rules", patches, files });
export const feature = promptRulesFeature;
export default promptRulesFeature;
