import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "eval-search-guard.mjs",
  "measurement-recorder.mjs",
  "tool-output.mjs",
  "tool-output-policy.mjs",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/adapter-hooks/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const adapterHooksFeature = Object.freeze({ id: "adapter-hooks", patches, files });
export const feature = adapterHooksFeature;
export default adapterHooksFeature;
