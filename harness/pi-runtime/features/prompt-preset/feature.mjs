import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "extension.mjs",
  "settings.mjs",
  "presets.mjs",
  "tunings.mjs",
  "file-operations.mjs",
  "execution-tooling.mjs",
  "gpt-eval-routing.mjs",
  "THIRD_PARTY_NOTICES.md",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/prompt-preset/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const promptPresetFeature = Object.freeze({ id: "prompt-preset", patches, files });
export const feature = promptPresetFeature;
export default promptPresetFeature;
